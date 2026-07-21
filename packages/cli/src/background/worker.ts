import { EventEmitter } from 'node:events'
import { z } from 'zod'
import type { OpenCodeGateway } from '../opencode/gateway.js'
import { redact } from '../runtime/logger.js'
import type { ModelRef, TokenUsage } from '../types.js'
import type { TstClient } from '../tst/client.js'

const outputSchema = z.object({
  candidates: z
    .array(
      z.object({
        key: z.string().min(1).max(160),
        value: z.string().min(1).max(2_000),
        kind: z.enum([
          'token_statistics',
          'concept_anchor',
          'structure_pattern',
          'behavioral_claim',
          'preference',
        ]),
        file_hashes: z.record(z.string(), z.string()).optional(),
      }),
    )
    .max(12),
})

type Job = {
  key: string
  kind: 'foreground_turn' | 'validation' | 'graph_batch'
  sessionID: string
  summary: string
}

export type BackgroundStats = {
  paused: boolean
  queued: number
  running: boolean
  completed: number
  failed: number
  usage: TokenUsage
  cost: number
}

const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })

export class BackgroundWorker extends EventEmitter {
  readonly #gateway: OpenCodeGateway
  readonly #tst: TstClient | undefined
  #model: ModelRef
  #queue = new Map<string, Job>()
  #running = false
  #paused: boolean
  #sessionID: string | undefined
  #completed = 0
  #failed = 0
  #usage = emptyUsage()
  #cost = 0
  #candidateIDs: Array<{ sessionID: string; memoryID: string; kind: z.infer<typeof outputSchema>['candidates'][number]['kind'] }> = []
  #validationReferences = new Map<string, string[]>()

  constructor(options: {
    gateway: OpenCodeGateway
    tst?: TstClient
    model: ModelRef
    paused?: boolean
  }) {
    super()
    this.#gateway = options.gateway
    this.#tst = options.tst
    this.#model = options.model
    this.#paused = options.paused ?? false
  }

  setModel(model: ModelRef): void {
    this.#model = model
    this.#sessionID = undefined
  }

  pause(): void {
    this.#paused = true
    this.emit('change', this.stats)
  }

  resume(): void {
    this.#paused = false
    this.emit('change', this.stats)
    void this.#drain()
  }

  enqueue(kind: Job['kind'], sessionID: string, summary: string): void {
    const safeSummary = redact(summary).slice(0, 8_000)
    const key = `${kind}:${sessionID}`
    this.#queue.set(key, { key, kind, sessionID, summary: safeSummary })
    this.emit('change', this.stats)
    void this.#drain()
  }

  async recordSuccessfulValidation(sessionID: string, reference: string): Promise<void> {
    if (!this.#tst) return
    const safeReference = redact(reference).slice(0, 500)
    const references = this.#validationReferences.get(sessionID) ?? []
    this.#validationReferences.set(sessionID, [...references, safeReference].slice(-8))
    if (this.#validationReferences.size > 50) {
      this.#validationReferences.delete(this.#validationReferences.keys().next().value ?? '')
    }
    for (const candidate of this.#candidateIDs) {
      if (candidate.sessionID !== sessionID || candidate.kind !== 'behavioral_claim') continue
      await this.#tst
        .call('evidence.record', {
          session_id: sessionID,
          memory_id: candidate.memoryID,
          kind: 'command_success',
          reference: safeReference,
          success: true,
        })
        .catch(() => undefined)
    }
  }

  get stats(): BackgroundStats {
    return {
      paused: this.#paused,
      queued: this.#queue.size,
      running: this.#running,
      completed: this.#completed,
      failed: this.#failed,
      usage: { ...this.#usage },
      cost: this.#cost,
    }
  }

  isBackgroundSession(sessionID: string): boolean {
    return sessionID === this.#sessionID
  }

  async #drain(): Promise<void> {
    if (this.#running || this.#paused) return
    this.#running = true
    this.emit('change', this.stats)
    try {
      while (!this.#paused && this.#queue.size > 0) {
        const job = this.#queue.values().next().value as Job | undefined
        if (!job) break
        this.#queue.delete(job.key)
        try {
          await retry(() => this.#run(job), 3)
          this.#completed += 1
        } catch {
          this.#failed += 1
        }
        this.emit('change', this.stats)
      }
    } finally {
      this.#running = false
      this.emit('change', this.stats)
    }
  }

  async #run(job: Job): Promise<void> {
    if (!this.#tst) return
    const sessionID = await this.#ensureSession()
    const before = await this.#gateway.getSession(sessionID)
    const prompt = [
      'Canonicalize durable memory candidates from the event below.',
      'Return JSON only: {"candidates":[{"key":"...","value":"...","kind":"concept_anchor|structure_pattern|behavioral_claim|token_statistics|preference","file_hashes":{}}]}.',
      'Do not include secrets, credentials, raw message transcripts, unrestricted tool output, or claims not present in the input. Your output is only a candidate and never verification evidence.',
      `Event kind: ${job.kind}`,
      `Event summary:\n${job.summary}`,
    ].join('\n\n')
    await this.#gateway.prompt(sessionID, prompt)
    await this.#gateway.wait(sessionID)
    const messages = await this.#gateway.messages(sessionID)
    const output = findStructuredOutput(messages)
    const parsed = outputSchema.parse(output)
    for (const candidate of parsed.candidates) {
      const result = await this.#tst.call<{ id: string }>('memory.observe', {
        session_id: job.sessionID,
        key: candidate.key,
        value: candidate.value,
        kind: candidate.kind,
        scope: 'project',
        provenance: 'model_candidate',
        file_hashes: candidate.file_hashes ?? {},
      })
      this.#candidateIDs = this.#candidateIDs.filter(
        (item) => item.sessionID !== job.sessionID || item.memoryID !== result.id,
      )
      this.#candidateIDs.push({ sessionID: job.sessionID, memoryID: result.id, kind: candidate.kind })
      this.#candidateIDs = this.#candidateIDs.slice(-256)
      if (candidate.kind === 'behavioral_claim') {
        for (const reference of this.#validationReferences.get(job.sessionID) ?? []) {
          await this.#tst.call('evidence.record', {
            session_id: job.sessionID,
            memory_id: result.id,
            kind: 'command_success',
            reference,
            success: true,
          })
        }
      }
      if (candidate.kind === 'structure_pattern') {
        for (const [path, contentHash] of Object.entries(candidate.file_hashes ?? {})) {
          await this.#tst.call('evidence.record', {
            session_id: job.sessionID,
            memory_id: result.id,
            kind: 'content_hash',
            reference: path,
            content_hash: contentHash,
            success: true,
          })
        }
      }
    }
    const after = await this.#gateway.getSession(sessionID)
    addUsage(this.#usage, difference(after.tokens, before.tokens))
    this.#cost += Math.max(0, after.cost - before.cost)
  }

  async #ensureSession(): Promise<string> {
    if (this.#sessionID) {
      await this.#gateway.switchModel(this.#sessionID, this.#model)
      return this.#sessionID
    }
    const session = await this.#gateway.createSession(this.#model, true)
    this.#sessionID = session.id
    return session.id
  }
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
      // Try the previous text payload.
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

async function retry<T>(operation: () => Promise<T>, attempts: number): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt))
    }
  }
  throw lastError
}
