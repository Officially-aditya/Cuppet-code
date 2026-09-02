import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const LEDGER_SCHEMA_VERSION = 1
const DEFAULT_MAX_ENTRIES = 512
const DEFAULT_WEAK_TTL_MS = 30 * 24 * 60 * 60 * 1_000
const MAX_SOURCE_REFS = 8
const MAX_IDENTITY_REFS = 16
const MAX_KEY_BYTES = 120
const MAX_CLAIM_BYTES = 600

export type CandidateKind =
  | 'token_statistics'
  | 'concept_anchor'
  | 'structure_pattern'
  | 'behavioral_claim'
  | 'preference'

export type CandidateRelation = 'support' | 'correction' | 'contradiction'

export type CandidateLedgerObservation = {
  key: string
  claim: string
  kind: CandidateKind
  relation: CandidateRelation
  sessionID: string
  projectID: string
  sourceRef: string
  timestampMs: number
  trustedSupport: boolean
  explicitUser: boolean
  downstreamVerified: boolean
}

export type CandidateLedgerEntry = {
  key: string
  claim: string
  kind: CandidateKind
  support_count: number
  explicit_user_count: number
  correction_count: number
  session_count: number
  project_count: number
  contradiction_count: number
  downstream_verification_count: number
  last_seen: number
  source_refs: string[]
  session_refs: string[]
  project_refs: string[]
}

export type CandidateAdmission = {
  blocked: boolean
  explicitUserPreference: boolean
  independentlyReinforced: boolean
  reinforcementEvidenceCount: number
  score: number
  sourceRefs: string[]
}

type PersistedLedger = {
  version: number
  entries: CandidateLedgerEntry[]
}

/**
 * A bounded evidence accumulator. It is deliberately not a retrieval store:
 * the background model only canonicalizes claims and points at bounded source
 * IDs, while all admission counters and evidence decisions are deterministic.
 */
export class CandidateLedger {
  readonly #path: string | undefined
  readonly #now: () => number
  readonly #maxEntries: number
  readonly #weakTtlMs: number
  #entries = new Map<string, CandidateLedgerEntry>()
  #persisting = Promise.resolve()
  #writeID = 0
  #ready: Promise<void>

  constructor(options: {
    path?: string
    now?: () => number
    maxEntries?: number
    weakTtlMs?: number
  } = {}) {
    this.#path = options.path
    this.#now = options.now ?? Date.now
    this.#maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES))
    this.#weakTtlMs = Math.max(0, Math.floor(options.weakTtlMs ?? DEFAULT_WEAK_TTL_MS))
    this.#ready = this.#restore()
  }

  async ready(): Promise<void> {
    await this.#ready
  }

  get size(): number {
    return this.#entries.size
  }

  entry(key: string, kind: CandidateKind): CandidateLedgerEntry | undefined {
    const entry = this.#entries.get(ledgerKey(key, kind))
    return entry ? cloneEntry(entry) : undefined
  }

  observe(observation: CandidateLedgerObservation): CandidateLedgerEntry {
    const canonicalKey = bounded(observation.key, MAX_KEY_BYTES)
    const claim = bounded(observation.claim, MAX_CLAIM_BYTES)
    const id = ledgerKey(canonicalKey, observation.kind)
    const entry = this.#entries.get(id) ?? {
      key: canonicalKey,
      claim,
      kind: observation.kind,
      support_count: 0,
      explicit_user_count: 0,
      correction_count: 0,
      session_count: 0,
      project_count: 0,
      contradiction_count: 0,
      downstream_verification_count: 0,
      last_seen: observation.timestampMs,
      source_refs: [],
      session_refs: [],
      project_refs: [],
    }

    entry.key = canonicalKey
    entry.claim = claim
    entry.last_seen = Math.max(entry.last_seen, Math.max(0, Math.floor(observation.timestampMs)))

    // Canonicalization alone is never evidence. Only user-authored or
    // verifier-backed sources are allowed to change admission counters.
    if (observation.trustedSupport) {
      if (observation.relation === 'contradiction') {
        entry.contradiction_count = saturatingIncrement(entry.contradiction_count)
      } else {
        entry.support_count = saturatingIncrement(entry.support_count)
        if (observation.relation === 'correction') {
          entry.correction_count = saturatingIncrement(entry.correction_count)
          // A correction can resolve one earlier conflict instead of leaving a
          // claim permanently blocked after the user clarifies it.
          entry.contradiction_count = Math.max(0, entry.contradiction_count - 1)
        }
        if (observation.explicitUser) {
          entry.explicit_user_count = saturatingIncrement(entry.explicit_user_count)
        }
        if (observation.downstreamVerified) {
          entry.downstream_verification_count = saturatingIncrement(entry.downstream_verification_count)
        }
      }
      pushUniqueBounded(entry.session_refs, identityRef(observation.sessionID), MAX_IDENTITY_REFS)
      pushUniqueBounded(entry.project_refs, identityRef(observation.projectID), MAX_IDENTITY_REFS)
    }
    entry.session_count = entry.session_refs.length
    entry.project_count = entry.project_refs.length
    if (observation.sourceRef) pushUniqueBounded(entry.source_refs, bounded(observation.sourceRef, 160), MAX_SOURCE_REFS)

    this.#entries.set(id, entry)
    this.#enforceBound()
    return cloneEntry(this.#entries.get(id) ?? entry)
  }

  admission(key: string, kind: CandidateKind): CandidateAdmission {
    const entry = this.#entries.get(ledgerKey(key, kind))
    if (!entry) {
      return {
        blocked: false,
        explicitUserPreference: false,
        independentlyReinforced: false,
        reinforcementEvidenceCount: 0,
        score: 0.5,
        sourceRefs: [],
      }
    }
    const blocked = entry.contradiction_count > 0
    const independentlyReinforced = !blocked && hasIndependentReinforcement(entry)
    return {
      blocked,
      explicitUserPreference: !blocked && kind === 'preference' && entry.explicit_user_count > 0,
      independentlyReinforced,
      reinforcementEvidenceCount: independentlyReinforced ? reinforcementEvidenceCount(entry) : 0,
      score: admissionScore(entry, this.#now()),
      sourceRefs: [...entry.source_refs],
    }
  }

  decay(nowMs = this.#now()): number {
    const before = this.#entries.size
    for (const [id, entry] of this.#entries) {
      const weak = entry.explicit_user_count === 0
        && entry.correction_count === 0
        && entry.downstream_verification_count === 0
        && !hasIndependentReinforcement(entry)
      if (weak && Math.max(0, nowMs - entry.last_seen) > this.#weakTtlMs) this.#entries.delete(id)
    }
    return before - this.#entries.size
  }

  compact(): number {
    const before = this.#entries.size
    this.decay()
    this.#enforceBound()
    return before - this.#entries.size
  }

  async persist(): Promise<void> {
    await this.#ready
    if (!this.#path) return
    this.compact()
    const snapshot: PersistedLedger = {
      version: LEDGER_SCHEMA_VERSION,
      entries: [...this.#entries.values()].map(cloneEntry),
    }
    this.#persisting = this.#persisting.catch(() => undefined).then(async () => {
      if (!this.#path) return
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 })
      const temporary = `${this.#path}.${process.pid}.${this.#writeID++}.tmp`
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 })
      await rename(temporary, this.#path)
    })
    await this.#persisting
  }

  async close(): Promise<void> {
    await this.persist()
  }

  async #restore(): Promise<void> {
    if (!this.#path) return
    try {
      const parsed = JSON.parse(await readFile(this.#path, 'utf8')) as Partial<PersistedLedger>
      if (parsed.version !== LEDGER_SCHEMA_VERSION || !Array.isArray(parsed.entries)) return
      for (const raw of parsed.entries.slice(-this.#maxEntries * 2)) {
        const entry = normalizePersistedEntry(raw)
        if (!entry) continue
        this.#entries.set(ledgerKey(entry.key, entry.kind), entry)
      }
      this.compact()
    } catch {
      // The ledger is an evidence cache, never the authoritative LTM. Missing
      // or malformed state therefore fails closed to an empty ledger.
      this.#entries.clear()
    }
  }

  #enforceBound(): void {
    while (this.#entries.size > this.#maxEntries) {
      const victim = [...this.#entries.entries()]
        .sort((left, right) => retentionStrength(left[1]) - retentionStrength(right[1])
          || left[1].last_seen - right[1].last_seen
          || left[0].localeCompare(right[0]))[0]?.[0]
      if (!victim) return
      this.#entries.delete(victim)
    }
  }
}

export function canonicalLedgerKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s\-_]+/g, ' ').replace(/[^\p{L}\p{N} .:/]/gu, '').replace(/\s+/g, ' ')
}

export function hasDurableUserCue(value: string): boolean {
  const text = value.trim()
  if (!text) return false
  return /\b(?:i\s+(?:prefer|want|like)|i(?:'d| would)\s+rather|always\s+use|never\s+(?:use|do)|do\s+not\s+(?:use|do)|don't\s+(?:use|do)|remember\s+(?:that|this)|from\s+now\s+on|this\s+(?:repo|project)\s+should|should\s+(?:always\s+)?use|must\s+(?:always\s+)?use|i\s+said|already\s+told\s+you|don't\s+do\s+that\s+again)\b/i.test(text)
    || /^(?:please\s+)?(?:use|avoid|keep|prefer|never\s+use|don't\s+use|do\s+not\s+use)\b/i.test(text)
}

export function hasCorrectionCue(value: string): boolean {
  return /\b(?:i\s+said|already\s+told\s+you|don't\s+do\s+that\s+again|do\s+not\s+do\s+that\s+again|as\s+i\s+said|again[, :]\s*(?:use|don't|do\s+not|never))\b/i.test(value)
}

export function candidateSourceRef(kind: string, value: string): string {
  return `${kind}:${createHash('sha256').update(`${kind}\0${value}`).digest('hex').slice(0, 16)}`
}

function hasIndependentReinforcement(entry: CandidateLedgerEntry): boolean {
  return entry.session_count >= 2
    || entry.project_count >= 2
    || entry.correction_count > 0
    || entry.support_count >= 3
}

function reinforcementEvidenceCount(entry: CandidateLedgerEntry): number {
  let count = 0
  if (entry.session_count >= 2) count += 2
  if (entry.project_count >= 2) count += 1
  if (entry.support_count >= 3) count += 1
  if (entry.correction_count > 0) count += 2
  return Math.min(4, count)
}

function admissionScore(entry: CandidateLedgerEntry, nowMs: number): number {
  let score = 0.5
  if (entry.explicit_user_count > 0) score += 0.1
  if (entry.session_count >= 2) score += 0.2
  if (entry.project_count >= 2) score += 0.1
  if (entry.support_count >= 3) score += 0.1
  if (entry.correction_count > 0) score += 0.2
  if (entry.downstream_verification_count > 0) score += 0.1
  if (entry.contradiction_count > 0) score = Math.min(score, 0.79)

  const ageDays = Math.max(0, nowMs - entry.last_seen) / 86_400_000
  if (ageDays > 30
    && entry.explicit_user_count === 0
    && entry.downstream_verification_count === 0
    && !hasIndependentReinforcement(entry)) {
    score *= 0.98 ** (ageDays - 30)
  }
  return Math.max(0, Math.min(1, score))
}

function retentionStrength(entry: CandidateLedgerEntry): number {
  return entry.explicit_user_count * 100
    + entry.downstream_verification_count * 50
    + entry.correction_count * 30
    + Math.max(0, entry.session_count - 1) * 20
    + Math.max(0, entry.project_count - 1) * 20
    + entry.support_count
    - Math.min(entry.contradiction_count, entry.support_count)
}

function normalizePersistedEntry(value: unknown): CandidateLedgerEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Partial<CandidateLedgerEntry>
  if (!isCandidateKind(raw.kind) || typeof raw.key !== 'string' || typeof raw.claim !== 'string') return undefined
  const numeric = (input: unknown) => typeof input === 'number' && Number.isFinite(input) ? Math.max(0, Math.floor(input)) : 0
  const refs = (input: unknown, max: number) => Array.isArray(input)
    ? input.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(-max)
    : []
  const entry: CandidateLedgerEntry = {
    key: bounded(raw.key, MAX_KEY_BYTES),
    claim: bounded(raw.claim, MAX_CLAIM_BYTES),
    kind: raw.kind,
    support_count: numeric(raw.support_count),
    explicit_user_count: numeric(raw.explicit_user_count),
    correction_count: numeric(raw.correction_count),
    session_count: 0,
    project_count: 0,
    contradiction_count: numeric(raw.contradiction_count),
    downstream_verification_count: numeric(raw.downstream_verification_count),
    last_seen: numeric(raw.last_seen),
    source_refs: refs(raw.source_refs, MAX_SOURCE_REFS),
    session_refs: refs(raw.session_refs, MAX_IDENTITY_REFS),
    project_refs: refs(raw.project_refs, MAX_IDENTITY_REFS),
  }
  entry.session_count = entry.session_refs.length
  entry.project_count = entry.project_refs.length
  return entry
}

function isCandidateKind(value: unknown): value is CandidateKind {
  return value === 'token_statistics'
    || value === 'concept_anchor'
    || value === 'structure_pattern'
    || value === 'behavioral_claim'
    || value === 'preference'
}

function ledgerKey(key: string, kind: CandidateKind): string {
  return `${kind}:${canonicalLedgerKey(key)}`
}

function identityRef(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16)
}

function pushUniqueBounded(values: string[], value: string, max: number): void {
  if (values.includes(value)) return
  values.push(value)
  if (values.length > max) values.splice(0, values.length - max)
}

function saturatingIncrement(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + 1)
}

function bounded(value: string, maxBytes: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
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

function cloneEntry(entry: CandidateLedgerEntry): CandidateLedgerEntry {
  return {
    ...entry,
    source_refs: [...entry.source_refs],
    session_refs: [...entry.session_refs],
    project_refs: [...entry.project_refs],
  }
}
