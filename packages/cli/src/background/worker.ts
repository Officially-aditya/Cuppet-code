import { EventEmitter } from 'node:events'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { OpenCodeGateway } from '../opencode/gateway.js'
import { redact } from '../runtime/logger.js'
import type { ModelRef, TokenUsage } from '../types.js'
import type { TstClient } from '../tst/client.js'

const MAX_BATCH_INPUT_BYTES = 4 * 1024
const MAX_SIGNAL_BYTES = 1_200
const MAX_SIGNALS_PER_BATCH = 8
const MAX_PERSISTED_BATCHES = 50
const DEFAULT_IDLE_DELAY_MS = 60_000
const DEFAULT_COOLDOWN_MS = 15 * 60_000
const PENDING_SCHEMA_VERSION = 1

const candidateSchema = z.object({
  key: z.string().min(1).max(120),
  value: z.string().min(1).max(600),
  kind: z.enum([
    'token_statistics',
    'concept_anchor',
    'structure_pattern',
    'behavioral_claim',
    'preference',
  ]),
  file_hashes: z.record(z.string().min(1).max(512), z.string().min(1).max(128)).optional(),
}).strict()

const outputSchema = z.object({
  candidates: z.array(candidateSchema).max(4),
}).strict()

type Candidate = z.infer<typeof candidateSchema>
type SignalKind = 'verified_diff' | 'validation'

type BatchSignal = {
  kind: SignalKind
  summary: string
  recordedAt: number
}

type PendingBatch = {
  sessionID: string
  signals: BatchSignal[]
  updatedAt: number
  idleAt?: number
}

type PersistedBackgroundState = {
  version: number
  batches: Array<{
    sessionID: string
    signals: BatchSignal[]
    updatedAt: number
  }>
  cooldowns: Array<{ sessionID: string; completedAt: number }>
}

export type BackgroundBatchStats = {
  attempts: number
  usage: TokenUsage
  cost: number
  candidates: number
  status: 'completed' | 'failed' | 'cancelled'
  completedAt: number
}

export type BackgroundStats = {
  paused: boolean
  queued: number
  deferred: number
  deferredBatches: number
  running: boolean
  completed: number
  failed: number
  attempts: number
  cancellations: number
  usage: TokenUsage
  cost: number
  lastBatch?: BackgroundBatchStats
}

type AttemptResult = {
  usage: TokenUsage
  cost: number
  candidates: number
}

type BatchRunResult = {
  status: BackgroundBatchStats['status']
  telemetry: BackgroundBatchStats
}

const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })

/**
 * Secondary-model canonicalization is deliberately deferred.  Native TST
 * indexing and graph persistence remain eager; this worker only processes
 * bounded evidence after the foreground has been idle for long enough.
 */
export class BackgroundWorker extends EventEmitter {
  readonly #gateway: OpenCodeGateway
  readonly #tst: TstClient | undefined
  readonly #pendingPath: string | undefined
  readonly #now: () => number
  readonly #idleDelayMs: number
  readonly #cooldownMs: number
  #model: ModelRef
  #batches = new Map<string, PendingBatch>()
  #lastCompleted = new Map<string, number>()
  #running = false
  #paused: boolean
  #foregroundActive = false
  #inFlight: PendingBatch | undefined
  #cancellationRequested: PendingBatch | undefined
  #activeSecondarySessionID: string | undefined
  #backgroundSessions = new Set<string>()
  #timer: ReturnType<typeof setTimeout> | undefined
  #ready: Promise<void>
  #persisting = Promise.resolve()
  #writeID = 0
  #completed = 0
  #failed = 0
  #attempts = 0
  #cancellations = 0
  #usage = emptyUsage()
  #cost = 0
  #lastBatch: BackgroundBatchStats | undefined
  #candidateIDs: Array<{ sessionID: string; memoryID: string; kind: Candidate['kind'] }> = []
  #validationReferences = new Map<string, string[]>()

  constructor(options: {
    gateway: OpenCodeGateway
    tst?: TstClient
    model: ModelRef
    paused?: boolean
    projectStore?: string
    now?: () => number
    idleDelayMs?: number
    cooldownMs?: number
  }) {
    super()
    this.#gateway = options.gateway
    this.#tst = options.tst
    this.#model = options.model
    this.#paused = options.paused ?? false
    this.#pendingPath = options.projectStore ? join(options.projectStore, 'background-pending.json') : undefined
    this.#now = options.now ?? Date.now
    this.#idleDelayMs = Math.max(0, options.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS)
    this.#cooldownMs = Math.max(0, options.cooldownMs ?? DEFAULT_COOLDOWN_MS)
    this.#ready = this.#restore()
  }

  async ready(): Promise<void> {
    await this.#ready
  }

  setModel(model: ModelRef): void {
    this.#model = model
  }

  pause(): void {
    this.#paused = true
    this.#clearTimer()
    this.#cancelInFlight()
    this.emit('change', this.stats)
  }

  resume(): void {
    this.#paused = false
    void this.#ready.then(() => {
      this.#schedule()
      this.emit('change', this.stats)
    })
  }

  /** Mark the foreground as active before any prompt work begins. */
  foregroundStarted(): void {
    this.#foregroundActive = true
    this.#clearTimer()
    void this.#ready.then(async () => {
      this.#cancelInFlight()
      await this.#persistPending()
      this.emit('change', this.stats)
    })
  }

  /** Start the idle debounce once foreground work has actually settled. */
  foregroundIdle(_sessionID: string): void {
    this.#foregroundActive = false
    void this.#ready.then(async () => {
      const idleAt = this.#now() + this.#idleDelayMs
      for (const batch of this.#batches.values()) batch.idleAt = idleAt
      await this.#persistPending()
      this.#schedule()
      this.emit('change', this.stats)
    })
  }

  async recordVerifiedDiff(sessionID: string, diff: string): Promise<void> {
    await this.#ready
    this.#recordSignal(sessionID, 'verified_diff', diff)
    await this.#persistPending()
    this.#schedule()
    this.emit('change', this.stats)
  }

  async recordSuccessfulValidation(sessionID: string, reference: string): Promise<void> {
    await this.#ready
    const safeReference = bounded(redact(reference), 500)
    if (!safeReference) return
    this.#recordSignal(sessionID, 'validation', safeReference)
    const references = this.#validationReferences.get(sessionID) ?? []
    this.#validationReferences.set(sessionID, [...references, safeReference].slice(-8))
    if (this.#validationReferences.size > 50) {
      this.#validationReferences.delete(this.#validationReferences.keys().next().value ?? '')
    }
    if (this.#tst) {
      for (const candidate of this.#candidateIDs) {
        if (candidate.sessionID !== sessionID || candidate.kind !== 'behavioral_claim') continue
        await this.#tst.call('evidence.record', {
          session_id: sessionID,
          memory_id: candidate.memoryID,
          kind: 'command_success',
          reference: safeReference,
          success: true,
        }).catch(() => undefined)
      }
    }
    await this.#persistPending()
    this.#schedule()
    this.emit('change', this.stats)
  }

  async close(): Promise<void> {
    this.pause()
    await this.#ready
    await this.#persistPending()
  }

  get stats(): BackgroundStats {
    const deferred = this.#deferredCount()
    return {
      paused: this.#paused,
      queued: this.#batches.size,
      deferred,
      deferredBatches: deferred,
      running: this.#running,
      completed: this.#completed,
      failed: this.#failed,
      attempts: this.#attempts,
      cancellations: this.#cancellations,
      usage: { ...this.#usage },
      cost: this.#cost,
      ...(this.#lastBatch ? { lastBatch: cloneBatchStats(this.#lastBatch) } : {}),
    }
  }

  isBackgroundSession(sessionID: string): boolean {
    return this.#backgroundSessions.has(sessionID)
  }

  #recordSignal(sessionID: string, kind: SignalKind, summary: string): void {
    const safeSessionID = bounded(redact(sessionID), 256)
    const safeSummary = bounded(redact(summary), MAX_SIGNAL_BYTES)
    if (!safeSessionID || !safeSummary) return
    const now = this.#now()
    const batch = this.#batches.get(safeSessionID) ?? {
      sessionID: safeSessionID,
      signals: [],
      updatedAt: now,
    }
    if (!batch.signals.some((signal) => signal.kind === kind && signal.summary === safeSummary)) {
      batch.signals.push({ kind, summary: safeSummary, recordedAt: now })
      batch.signals = batch.signals.slice(-MAX_SIGNALS_PER_BATCH)
    }
    batch.updatedAt = now
    this.#batches.set(safeSessionID, batch)
  }

  #schedule(): void {
    this.#clearTimer()
    if (this.#running || this.#paused || this.#foregroundActive || !this.#tst) return
    const next = this.#nextEligibleAt()
    if (next === undefined) return
    const delay = Math.max(0, next - this.#now())
    if (delay === 0) {
      void this.#drain()
      return
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.#drain()
    }, delay)
    this.#timer.unref?.()
  }

  #clearTimer(): void {
    if (!this.#timer) return
    clearTimeout(this.#timer)
    this.#timer = undefined
  }

  async #drain(): Promise<void> {
    await this.#ready
    if (this.#running || this.#paused || this.#foregroundActive || !this.#tst) return
    this.#running = true
    this.emit('change', this.stats)
    try {
      while (!this.#paused && !this.#foregroundActive) {
        const batch = this.#nextReadyBatch()
        if (!batch) break
        this.#inFlight = batch
        this.#cancellationRequested = undefined
        const run = await this.#runBatch(batch)
        this.#inFlight = undefined

        if (run.status === 'completed') {
          if (this.#batches.get(batch.sessionID) === batch) this.#batches.delete(batch.sessionID)
          this.#lastCompleted.set(batch.sessionID, this.#now())
          this.#trimCooldowns()
          this.#completed += 1
        } else if (run.status === 'failed') {
          if (this.#batches.get(batch.sessionID) === batch) this.#batches.delete(batch.sessionID)
          this.#failed += 1
        }
        await this.#persistPending()
        this.emit('change', this.stats)
        if (run.status === 'cancelled') break
      }
    } finally {
      this.#inFlight = undefined
      this.#cancellationRequested = undefined
      this.#running = false
      this.#schedule()
      this.emit('change', this.stats)
    }
  }

  async #runBatch(batch: PendingBatch): Promise<BatchRunResult> {
    let attempts = 0
    let candidates = 0
    let usage = emptyUsage()
    let cost = 0
    let status: BackgroundBatchStats['status'] = 'failed'

    while (attempts < 2) {
      attempts += 1
      this.#attempts += 1
      try {
        const attempt = await this.#runAttempt(batch)
        addUsage(usage, attempt.usage)
        cost += attempt.cost
        candidates += attempt.candidates
        if (this.#isCancelled(batch)) {
          status = 'cancelled'
        } else {
          status = 'completed'
        }
        break
      } catch (error) {
        const failure = error instanceof AttemptFailure ? error : new AttemptFailure(error, emptyUsage(), 0)
        addUsage(usage, failure.usage)
        cost += failure.cost
        if (this.#isCancelled(batch)) {
          status = 'cancelled'
          break
        }
        // Only a single retry is allowed, and only for a transport failure.
        if (attempts < 2 && isTransientTransportFailure(failure.original)) continue
        status = 'failed'
        break
      }
    }

    addUsage(this.#usage, usage)
    this.#cost += cost
    const telemetry: BackgroundBatchStats = {
      attempts,
      usage,
      cost,
      candidates,
      status,
      completedAt: this.#now(),
    }
    this.#lastBatch = telemetry
    return { status, telemetry }
  }

  async #runAttempt(batch: PendingBatch): Promise<AttemptResult> {
    const tst = this.#tst
    if (!tst) throw new AttemptFailure(new Error('TST memory is unavailable'), emptyUsage(), 0)

    let session: { id: string; tokens: TokenUsage; cost: number } | undefined
    let before: { tokens: TokenUsage; cost: number } | undefined
    let candidates = 0
    let failure: unknown
    try {
      if (this.#isCancelled(batch)) throw new BackgroundCancelledError()
      session = await this.#gateway.createSession(this.#model, true)
      this.#rememberBackgroundSession(session.id)
      this.#activeSecondarySessionID = session.id
      // A foreground request can arrive while the secondary session is being
      // created. Do not send it a prompt after that request has begun.
      if (this.#isCancelled(batch)) throw new BackgroundCancelledError()
      before = await this.#gateway.getSession(session.id).catch(() => session)
      if (this.#isCancelled(batch)) throw new BackgroundCancelledError()
      const summary = batchSummary(batch)
      const prompt = [
        'Canonicalize at most four short durable memory candidates from verified foreground signals.',
        'Return JSON only: {"candidates":[{"key":"...","value":"...","kind":"concept_anchor|structure_pattern|behavioral_claim|token_statistics|preference","file_hashes":{}}]}.',
        'Use only claims supported by the supplied signals. Do not include secrets, credentials, raw transcripts, unrestricted tool output, or unverifiable claims. Candidates are not verification evidence.',
        `Verified signals (redacted and bounded to ${MAX_BATCH_INPUT_BYTES} bytes):\n${summary}`,
      ].join('\n\n')
      if (Buffer.byteLength(prompt) > MAX_BATCH_INPUT_BYTES + 1_000) {
        throw new Error('background batch prompt exceeded its bounded input budget')
      }
      await this.#gateway.prompt(session.id, prompt)
      await this.#gateway.wait(session.id)
      if (this.#isCancelled(batch)) throw new BackgroundCancelledError()
      const messages = await this.#gateway.messages(session.id)
      const parsed = outputSchema.parse(findStructuredOutput(messages))
      for (const candidate of parsed.candidates) {
        if (this.#isCancelled(batch)) throw new BackgroundCancelledError()
        const result = await tst.call<{ id: string }>('memory.observe', {
          session_id: batch.sessionID,
          key: candidate.key,
          value: candidate.value,
          kind: candidate.kind,
          scope: 'project',
          provenance: 'model_candidate',
          file_hashes: candidate.file_hashes ?? {},
        })
        candidates += 1
        this.#candidateIDs = this.#candidateIDs.filter(
          (item) => item.sessionID !== batch.sessionID || item.memoryID !== result.id,
        )
        this.#candidateIDs.push({ sessionID: batch.sessionID, memoryID: result.id, kind: candidate.kind })
        this.#candidateIDs = this.#candidateIDs.slice(-256)
        if (candidate.kind === 'behavioral_claim') {
          for (const reference of this.#validationReferences.get(batch.sessionID) ?? []) {
            await tst.call('evidence.record', {
              session_id: batch.sessionID,
              memory_id: result.id,
              kind: 'command_success',
              reference,
              success: true,
            })
          }
        }
        if (candidate.kind === 'structure_pattern') {
          for (const [path, contentHash] of Object.entries(candidate.file_hashes ?? {})) {
            await tst.call('evidence.record', {
              session_id: batch.sessionID,
              memory_id: result.id,
              kind: 'content_hash',
              reference: path,
              content_hash: contentHash,
              success: true,
            })
          }
        }
      }
    } catch (error) {
      failure = error
    } finally {
      const after = session
        ? await this.#gateway.getSession(session.id).catch(() => before ?? session)
        : undefined
      if (this.#activeSecondarySessionID === session?.id) this.#activeSecondarySessionID = undefined
      const usage = after && before ? difference(after.tokens, before.tokens) : emptyUsage()
      const cost = after && before ? Math.max(0, after.cost - before.cost) : 0
      if (failure) throw new AttemptFailure(failure, usage, cost)
      return { usage, cost, candidates }
    }
  }

  #isCancelled(batch: PendingBatch): boolean {
    return this.#paused || this.#foregroundActive || this.#cancellationRequested === batch
  }

  #cancelInFlight(): void {
    const batch = this.#inFlight
    if (!batch || this.#cancellationRequested === batch) return
    this.#cancellationRequested = batch
    this.#cancellations += 1
    if (this.#activeSecondarySessionID) {
      void this.#gateway.interrupt(this.#activeSecondarySessionID).catch(() => undefined)
    }
  }

  #rememberBackgroundSession(sessionID: string): void {
    this.#backgroundSessions.add(sessionID)
    if (this.#backgroundSessions.size <= 256) return
    const oldest = this.#backgroundSessions.values().next().value as string | undefined
    if (oldest) this.#backgroundSessions.delete(oldest)
  }

  #nextReadyBatch(): PendingBatch | undefined {
    const now = this.#now()
    return [...this.#batches.values()]
      .filter((batch) => batch !== this.#inFlight && this.#eligibleAt(batch) <= now)
      .sort((left, right) => left.updatedAt - right.updatedAt || left.sessionID.localeCompare(right.sessionID))[0]
  }

  #nextEligibleAt(): number | undefined {
    let next: number | undefined
    for (const batch of this.#batches.values()) {
      if (batch === this.#inFlight) continue
      const eligibleAt = this.#eligibleAt(batch)
      if (!Number.isFinite(eligibleAt)) continue
      next = next === undefined ? eligibleAt : Math.min(next, eligibleAt)
    }
    return next
  }

  #eligibleAt(batch: PendingBatch): number {
    if (batch.idleAt === undefined) return Number.POSITIVE_INFINITY
    const cooldownUntil = (this.#lastCompleted.get(batch.sessionID) ?? 0) + this.#cooldownMs
    return Math.max(batch.idleAt, cooldownUntil)
  }

  #deferredCount(): number {
    if (this.#batches.size === 0) return 0
    if (this.#paused || this.#foregroundActive) {
      return this.#batches.size - Number(this.#inFlight !== undefined)
    }
    const now = this.#now()
    return [...this.#batches.values()]
      .filter((batch) => batch !== this.#inFlight && this.#eligibleAt(batch) > now)
      .length
  }

  #trimCooldowns(): void {
    if (this.#lastCompleted.size <= MAX_PERSISTED_BATCHES) return
    const oldest = [...this.#lastCompleted.entries()].sort((left, right) => left[1] - right[1])[0]?.[0]
    if (oldest) this.#lastCompleted.delete(oldest)
  }

  async #restore(): Promise<void> {
    if (!this.#pendingPath) return
    try {
      const parsed = JSON.parse(await readFile(this.#pendingPath, 'utf8')) as Partial<PersistedBackgroundState>
      if (parsed.version !== PENDING_SCHEMA_VERSION || !Array.isArray(parsed.batches)) return
      const now = this.#now()
      for (const raw of parsed.batches.slice(-MAX_PERSISTED_BATCHES)) {
        const sessionID = typeof raw.sessionID === 'string' ? bounded(redact(raw.sessionID), 256) : ''
        if (!sessionID || !Array.isArray(raw.signals)) continue
        const signals = raw.signals
          .filter((signal): signal is BatchSignal =>
            Boolean(signal)
            && (signal.kind === 'verified_diff' || signal.kind === 'validation')
            && typeof signal.summary === 'string'
            && typeof signal.recordedAt === 'number',
          )
          .slice(-MAX_SIGNALS_PER_BATCH)
          .map((signal) => ({
            kind: signal.kind,
            summary: bounded(redact(signal.summary), MAX_SIGNAL_BYTES),
            recordedAt: Math.max(0, Math.floor(signal.recordedAt)),
          }))
          .filter((signal) => signal.summary.length > 0)
        if (signals.length === 0) continue
        this.#batches.set(sessionID, {
          sessionID,
          signals,
          updatedAt: typeof raw.updatedAt === 'number' ? Math.max(0, Math.floor(raw.updatedAt)) : now,
          // A restart waits for the next foreground idle notification rather
          // than treating process startup as an eligible idle period.
        })
      }
      if (Array.isArray(parsed.cooldowns)) {
        for (const raw of parsed.cooldowns.slice(-MAX_PERSISTED_BATCHES)) {
          const sessionID = typeof raw.sessionID === 'string' ? bounded(redact(raw.sessionID), 256) : ''
          const completedAt = typeof raw.completedAt === 'number' ? Math.max(0, Math.floor(raw.completedAt)) : 0
          if (sessionID && completedAt > 0) this.#lastCompleted.set(sessionID, completedAt)
        }
      }
      this.#schedule()
    } catch {
      // A missing or malformed private pending file is non-fatal.  It contains
      // only deferred candidates and never affects native graph freshness.
    }
  }

  async #persistPending(): Promise<void> {
    if (!this.#pendingPath) return
    const snapshot: PersistedBackgroundState = {
      version: PENDING_SCHEMA_VERSION,
      batches: [...this.#batches.values()]
        .slice(-MAX_PERSISTED_BATCHES)
        .map((batch) => ({
          sessionID: bounded(redact(batch.sessionID), 256),
          signals: batch.signals.slice(-MAX_SIGNALS_PER_BATCH).map((signal) => ({
            kind: signal.kind,
            summary: bounded(redact(signal.summary), MAX_SIGNAL_BYTES),
            recordedAt: signal.recordedAt,
          })),
          updatedAt: batch.updatedAt,
        })),
      cooldowns: [...this.#lastCompleted.entries()]
        .sort((left, right) => left[1] - right[1])
        .slice(-MAX_PERSISTED_BATCHES)
        .map(([sessionID, completedAt]) => ({ sessionID: bounded(redact(sessionID), 256), completedAt })),
    }
    this.#persisting = this.#persisting.catch(() => undefined).then(async () => {
      const directory = this.#pendingPath ? dirname(this.#pendingPath) : undefined
      if (!directory || !this.#pendingPath) return
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const temporary = `${this.#pendingPath}.${process.pid}.${this.#writeID++}.tmp`
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 })
      await rename(temporary, this.#pendingPath)
    }).catch(() => undefined)
    await this.#persisting
  }
}

class BackgroundCancelledError extends Error {
  constructor() {
    super('background batch cancelled for foreground work')
  }
}

class AttemptFailure extends Error {
  readonly original: unknown
  readonly usage: TokenUsage
  readonly cost: number

  constructor(original: unknown, usage: TokenUsage, cost: number) {
    super(errorMessage(original))
    this.original = original
    this.usage = usage
    this.cost = cost
  }
}

function batchSummary(batch: PendingBatch): string {
  const lines = batch.signals.map((signal) => {
    const label = signal.kind === 'verified_diff' ? 'Verified diff' : 'Successful validation'
    return `- ${label}: ${signal.summary}`
  })
  return bounded(lines.join('\n'), MAX_BATCH_INPUT_BYTES)
}

function bounded(value: string, maxBytes: number): string {
  const normalized = value.trim()
  if (Buffer.byteLength(normalized) <= maxBytes) return normalized
  let low = 0
  let high = normalized.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(normalized.slice(0, middle)) <= Math.max(0, maxBytes - 1)) low = middle
    else high = middle - 1
  }
  return `${normalized.slice(0, low)}…`
}

function findStructuredOutput(messages: unknown[]): unknown {
  const strings = collectStrings(messages).reverse()
  for (const value of strings) {
    const start = value.indexOf('{')
    const end = value.lastIndexOf('}')
    if (start < 0 || end <= start) continue
    try {
      const parsed: unknown = JSON.parse(value.slice(start, end + 1))
      if (outputSchema.safeParse(parsed).success) return parsed
    } catch {
      // Try an earlier text payload.
    }
  }
  throw new Error('secondary model did not return schema-valid JSON')
}

function collectStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, output)
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (['text', 'content', 'output'].includes(key)) collectStrings(item, output)
      else if (typeof item === 'object') collectStrings(item, output)
    }
  }
  return output
}

function isTransientTransportFailure(error: unknown): boolean {
  if (error instanceof z.ZodError || error instanceof BackgroundCancelledError) return false
  const text = errorMessage(error).toLowerCase()
  if (/schema|semantic|candidate rejected|secret-bearing|invalid json/.test(text)) return false
  return /econnreset|econnrefused|epipe|etimedout|enotfound|network|fetch failed|socket (?:closed|hang up)|connection (?:closed|reset|refused)|temporar(?:y|ily) unavailable|http 5\d\d|timed out/.test(text)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function difference(after: TokenUsage, before: TokenUsage): TokenUsage {
  return {
    input: Math.max(0, after.input - before.input),
    output: Math.max(0, after.output - before.output),
    reasoning: Math.max(0, after.reasoning - before.reasoning),
    cacheRead: Math.max(0, after.cacheRead - before.cacheRead),
    cacheWrite: Math.max(0, after.cacheWrite - before.cacheWrite),
  }
}

function addUsage(target: TokenUsage, value: TokenUsage): void {
  target.input += value.input
  target.output += value.output
  target.reasoning += value.reasoning
  target.cacheRead += value.cacheRead
  target.cacheWrite += value.cacheWrite
}

function cloneBatchStats(stats: BackgroundBatchStats): BackgroundBatchStats {
  return { ...stats, usage: { ...stats.usage } }
}
