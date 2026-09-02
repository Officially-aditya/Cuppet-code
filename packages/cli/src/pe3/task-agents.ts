const MAX_TERMS = 32
const MAX_PATHS = 16
const MAX_SYMBOLS = 16
const MAX_DESCRIPTOR_BYTES = 320
const FINGERPRINT_DECAY = 0.96
const MIN_FINGERPRINT_WEIGHT = 0.08
const STRONG_LEXICAL_WEIGHT = 0.9

const CONTINUATION_CUES = [
  'also',
  'that',
  'those',
  'the previous',
  'same task',
  'same issue',
  'continue',
  'keep going',
  'update the tests',
  'fix the tests',
  'what about',
]

const SWITCH_CUES = [
  'new task',
  'separate task',
  'separately',
  'unrelated',
  'instead',
  'switch to',
  'now build',
  'now implement',
  'move on to',
]

const RETURN_CUES = [
  'go back to',
  'return to',
  'back to',
  'resume the',
  'resume that',
  'previous task',
  'earlier task',
]

const STOP_TERMS = new Set([
  'about', 'after', 'again', 'also', 'and', 'are', 'been', 'before', 'build', 'can', 'change', 'code', 'could',
  'create', 'does', 'doing', 'file', 'files', 'fix', 'for', 'from', 'have', 'here', 'into', 'issue', 'just', 'make',
  'more', 'need', 'now', 'please', 'should', 'task', 'that', 'the', 'their', 'then', 'there', 'these', 'they', 'this',
  'those', 'update', 'use', 'using', 'want', 'what', 'when', 'where', 'which', 'with', 'work', 'working', 'would', 'you',
])

export type TaskAgentEvidence = {
  activePaths?: Iterable<string>
  touchedPaths?: Iterable<string>
  recentSymbols?: Iterable<string>
  /** Cheap graph/code-localization results for the incoming prompt. */
  localizedPaths?: Iterable<string>
  localizedSymbols?: Iterable<string>
  workspaceEpoch?: number
}

export type TaskFingerprintSignal = {
  value: string
  weight: number
  source: 'prompt' | 'localized' | 'active' | 'touched' | 'symbol'
  updatedAt: number
}

export type TaskFingerprint = {
  revision: number
  paths: TaskFingerprintSignal[]
  symbols: TaskFingerprintSignal[]
  terms: TaskFingerprintSignal[]
}

export type TaskAgentState = {
  id: string
  sessionID: string
  taskDescriptor: string
  activePaths: string[]
  touchedPaths: string[]
  recentSymbols: string[]
  terms: string[]
  fingerprint: TaskFingerprint
  stalePaths: string[]
  cacheEpoch: number
  workspaceEpoch: number
  createdAt: number
  lastActiveAt: number
  turns: number
}

export type TaskAffinity = {
  score: number
  pathOverlap: number
  symbolOverlap: number
  termOverlap: number
  lexicalRatio: number
  weightedOverlap: number
}

export type TaskRoute =
  | { action: 'continue'; agent: TaskAgentState; reason: string; affinity: TaskAffinity; semanticEligible?: boolean }
  | { action: 'reactivate'; agent: TaskAgentState; reason: string; affinity: TaskAffinity; refreshPaths: string[] }
  | { action: 'create'; reason: string; affinity: TaskAffinity }

/**
 * Deterministic PE3 task router.
 *
 * This component owns task-local inference state only. It never invokes a
 * model, never rewrites model-facing history, and never decides what belongs
 * in project/global memory. The controller may bind a task agent to an
 * OpenCode session, but dormant agents are inert data until reactivated.
 */
export class TaskAgentRouter {
  readonly #agents = new Map<string, TaskAgentState>()
  readonly #now: () => number
  #activeID: string | undefined
  #workspaceEpoch = 0

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now
  }

  get active(): TaskAgentState | undefined {
    return this.#activeID ? cloneAgent(this.#agents.get(this.#activeID)) : undefined
  }

  list(): TaskAgentState[] {
    return [...this.#agents.values()]
      .sort((left, right) => right.lastActiveAt - left.lastActiveAt)
      .map((agent) => cloneAgent(agent) as TaskAgentState)
  }

  register(sessionID: string, prompt = '', evidence: TaskAgentEvidence = {}): TaskAgentState {
    const id = agentID(sessionID)
    const existing = this.#agents.get(id)
    if (existing) {
      this.#activeID = id
      this.recordTurn(prompt, evidence)
      return cloneAgent(existing) as TaskAgentState
    }

    const now = this.#now()
    const state: TaskAgentState = {
      id,
      sessionID,
      taskDescriptor: boundedDescriptor(prompt),
      activePaths: boundedUnique(normalizePaths(evidence.activePaths ?? extractPaths(prompt)), MAX_PATHS),
      touchedPaths: boundedUnique(normalizePaths(evidence.touchedPaths ?? []), MAX_PATHS),
      recentSymbols: boundedUnique(normalizeSymbols(evidence.recentSymbols ?? extractSymbols(prompt)), MAX_SYMBOLS),
      terms: boundedUnique(extractTerms(prompt), MAX_TERMS),
      fingerprint: emptyFingerprint(),
      stalePaths: [],
      cacheEpoch: 0,
      workspaceEpoch: Math.max(this.#workspaceEpoch, evidence.workspaceEpoch ?? 0),
      createdAt: now,
      lastActiveAt: now,
      turns: prompt.trim() ? 1 : 0,
    }
    seedFingerprint(state, prompt, evidence, now)
    this.#agents.set(id, state)
    this.#activeID = id
    return cloneAgent(state) as TaskAgentState
  }

  activate(agentIDValue: string): TaskAgentState | undefined {
    const state = this.#agents.get(agentIDValue)
    if (!state) return undefined
    this.#activeID = state.id
    state.lastActiveAt = this.#now()
    return cloneAgent(state) as TaskAgentState
  }

  route(prompt: string, evidence: TaskAgentEvidence = {}): TaskRoute {
    const active = this.#activeID ? this.#agents.get(this.#activeID) : undefined
    if (!active) {
      return {
        action: 'create',
        reason: 'no active task agent',
        affinity: emptyAffinity(),
      }
    }

    // Only observed active/tool evidence is allowed to strengthen the current
    // task before the routing decision. Prompt-localized graph hits describe
    // the *incoming request* and are therefore query evidence, not active-task
    // evidence until the turn is actually committed to an agent.
    this.#mergeObservedEvidence(active, evidence)
    const currentAffinity = affinityFor(active, prompt, evidence)
    const normalizedPrompt = normalizeText(prompt)
    const explicitSwitch = hasCue(normalizedPrompt, SWITCH_CUES)
    const explicitReturn = hasCue(normalizedPrompt, RETURN_CUES)
    const dormant = this.#bestDormantMatch(active, prompt, normalizedPrompt, evidence)

    if (hasCue(normalizedPrompt, CONTINUATION_CUES)) {
      return {
        action: 'continue',
        agent: cloneAgent(active) as TaskAgentState,
        reason: 'continuation language defaults to the active agent',
        affinity: currentAffinity,
      }
    }

    // An explicit return to a known dormant task is stronger task identity
    // evidence than incidental path overlap on the currently active task. A
    // task may touch another task's file without taking ownership of it.
    if (explicitReturn && dormant) {
      return {
        action: 'reactivate',
        agent: cloneAgent(dormant.agent) as TaskAgentState,
        reason: 'explicit return language matches a dormant task agent',
        affinity: dormant.affinity,
        refreshPaths: [...dormant.agent.stalePaths],
      }
    }

    // Explicit task-boundary language must be evaluated before weak lexical
    // overlap. Generic words such as "src" or "export" are not enough to
    // keep an explicitly separate task on a contaminated session.
    if (!explicitSwitch && isStrongMatch(currentAffinity)) {
      return {
        action: 'continue',
        agent: cloneAgent(active) as TaskAgentState,
        reason: 'active working-set affinity is sufficient',
        affinity: currentAffinity,
      }
    }

    if (!isStrongMismatch(active, prompt, currentAffinity, evidence, explicitSwitch)) {
      return {
        action: 'continue',
        agent: cloneAgent(active) as TaskAgentState,
        reason: 'ambiguous or weak mismatch stays on the active agent',
        affinity: currentAffinity,
        ...(semanticEscalationEligible(prompt, currentAffinity) ? { semanticEligible: true } : {}),
      }
    }

    if (dormant) {
      return {
        action: 'reactivate',
        agent: cloneAgent(dormant.agent) as TaskAgentState,
        reason: 'strong active mismatch with a matching dormant task agent',
        affinity: dormant.affinity,
        refreshPaths: [...dormant.agent.stalePaths],
      }
    }

    return {
      action: 'create',
      reason: 'strong task mismatch with no matching dormant agent',
      affinity: currentAffinity,
    }
  }

  recordTurn(prompt: string, evidence: TaskAgentEvidence = {}): TaskAgentState | undefined {
    const active = this.#activeID ? this.#agents.get(this.#activeID) : undefined
    if (!active) return undefined
    const trimmed = prompt.trim()
    const now = this.#now()
    if (trimmed) {
      active.taskDescriptor = boundedDescriptor(trimmed)
      active.terms = mergeRecent(active.terms, extractTerms(trimmed), MAX_TERMS)
      active.activePaths = mergeRecent(active.activePaths, extractPaths(trimmed), MAX_PATHS)
      active.recentSymbols = mergeRecent(active.recentSymbols, extractSymbols(trimmed), MAX_SYMBOLS)
      active.turns += 1
      decayFingerprint(active.fingerprint)
    }
    this.#mergeObservedEvidence(active, evidence)
    commitPromptFingerprint(active, trimmed, evidence, now)
    active.lastActiveAt = now
    return cloneAgent(active) as TaskAgentState
  }

  noteWorkspaceChange(paths: Iterable<string>): void {
    const changed = new Set(normalizePaths(paths))
    if (changed.size === 0) return
    this.#workspaceEpoch += 1
    for (const agent of this.#agents.values()) {
      const privileged = new Set([...agent.activePaths, ...agent.touchedPaths])
      const stale = [...changed].filter((path) => privileged.has(path))
      if (stale.length === 0) continue
      agent.stalePaths = mergeRecent(agent.stalePaths, stale, MAX_PATHS)
      agent.workspaceEpoch = this.#workspaceEpoch
      agent.cacheEpoch += 1
      agent.fingerprint.revision += 1
    }
  }

  acknowledgeRefresh(agentIDValue: string, paths: Iterable<string>): void {
    const agent = this.#agents.get(agentIDValue)
    if (!agent) return
    const refreshed = new Set(normalizePaths(paths))
    if (refreshed.size === 0) return
    agent.stalePaths = agent.stalePaths.filter((path) => !refreshed.has(path))
  }

  #mergeObservedEvidence(agent: TaskAgentState, evidence: TaskAgentEvidence): void {
    const now = this.#now()
    const activePaths = normalizePaths(evidence.activePaths ?? [])
    const touchedPaths = normalizePaths(evidence.touchedPaths ?? [])
    const recentSymbols = normalizeSymbols(evidence.recentSymbols ?? [])
    agent.activePaths = mergeRecent(agent.activePaths, activePaths, MAX_PATHS)
    agent.touchedPaths = mergeRecent(agent.touchedPaths, touchedPaths, MAX_PATHS)
    agent.recentSymbols = mergeRecent(agent.recentSymbols, recentSymbols, MAX_SYMBOLS)
    mergeFingerprintSignals(agent.fingerprint.paths, activePaths, 0.78, 'active', MAX_PATHS, now)
    mergeFingerprintSignals(agent.fingerprint.paths, touchedPaths, 1, 'touched', MAX_PATHS, now)
    mergeFingerprintSignals(agent.fingerprint.symbols, recentSymbols, 0.84, 'symbol', MAX_SYMBOLS, now)
    if (activePaths.length > 0 || touchedPaths.length > 0 || recentSymbols.length > 0) {
      agent.fingerprint.revision += 1
    }
    if (evidence.workspaceEpoch !== undefined) {
      agent.workspaceEpoch = Math.max(agent.workspaceEpoch, evidence.workspaceEpoch)
      this.#workspaceEpoch = Math.max(this.#workspaceEpoch, evidence.workspaceEpoch)
    }
  }

  #bestDormantMatch(
    active: TaskAgentState,
    prompt: string,
    normalizedPrompt: string,
    evidence: TaskAgentEvidence,
  ): { agent: TaskAgentState; affinity: TaskAffinity } | undefined {
    return [...this.#agents.values()]
      .filter((agent) => agent.id !== active.id)
      .map((agent) => ({ agent, affinity: affinityFor(agent, prompt, evidence) }))
      .filter(({ affinity }) => isDormantMatch(affinity, normalizedPrompt))
      .sort((left, right) =>
        right.affinity.score - left.affinity.score || right.agent.lastActiveAt - left.agent.lastActiveAt,
      )[0]
  }
}

/** Compact semantic identity for a task. It intentionally excludes transcript text. */
export function taskFingerprintText(agent: TaskAgentState): string {
  const paths = strongest(agent.fingerprint.paths, 10)
  const symbols = strongest(agent.fingerprint.symbols, 10)
  const terms = strongest(agent.fingerprint.terms, 16)
  return [
    agent.taskDescriptor ? `task: ${agent.taskDescriptor}` : '',
    paths.length ? `artifacts: ${paths.map(renderSignal).join(', ')}` : '',
    symbols.length ? `symbols: ${symbols.map(renderSignal).join(', ')}` : '',
    terms.length ? `terms: ${terms.map(renderSignal).join(', ')}` : '',
  ].filter(Boolean).join('\n')
}

function affinityFor(agent: TaskAgentState, prompt: string, evidence: TaskAgentEvidence = {}): TaskAffinity {
  const paths = new Set([
    ...extractPaths(prompt),
    ...normalizePaths(evidence.localizedPaths ?? []),
  ])
  const symbols = new Set([
    ...extractSymbols(prompt),
    ...normalizeSymbols(evidence.localizedSymbols ?? []),
  ])
  const terms = new Set(extractTerms(prompt))
  const agentPaths = new Set(strongValues(agent.fingerprint.paths, 0.35))
  const agentSymbols = new Set(strongValues(agent.fingerprint.symbols, 0.35))
  const agentTerms = new Set(strongValues(agent.fingerprint.terms, 0.12))
  const pathOverlap = overlapCount(paths, agentPaths)
  const symbolOverlap = overlapCount(symbols, agentSymbols)
  const termOverlap = overlapCount(terms, agentTerms)
  const denominator = Math.max(1, Math.min(terms.size, agentTerms.size))
  const lexicalRatio = termOverlap / denominator
  const weightedOverlap = weightedOverlapScore(paths, agent.fingerprint.paths) * 8
    + weightedOverlapScore(symbols, agent.fingerprint.symbols) * 5
    + weightedOverlapScore(terms, agent.fingerprint.terms)
  return {
    score: weightedOverlap,
    pathOverlap,
    symbolOverlap,
    termOverlap,
    lexicalRatio,
    weightedOverlap,
  }
}

function isStrongMatch(affinity: TaskAffinity): boolean {
  if (affinity.pathOverlap > 0 || affinity.symbolOverlap > 0) return true
  // Raw term counts are deliberately insufficient: two generic words from a
  // single prompt (for example "service" and "retry") must not suppress the
  // semantic ambiguity band. Repeated/reinforced lexical identity can still
  // stay on the zero-model hot path once its fingerprint weight is strong.
  return affinity.weightedOverlap >= STRONG_LEXICAL_WEIGHT
    && (affinity.termOverlap >= 3 || affinity.lexicalRatio >= 0.6)
}

function isStrongMismatch(
  agent: TaskAgentState,
  prompt: string,
  affinity: TaskAffinity,
  evidence: TaskAgentEvidence,
  explicitSwitch = hasCue(normalizeText(prompt), SWITCH_CUES),
): boolean {
  const promptTerms = extractTerms(prompt)
  const promptPaths = boundedUnique([
    ...extractPaths(prompt),
    ...normalizePaths(evidence.localizedPaths ?? []),
  ], MAX_PATHS)
  const agentPaths = strongValues(agent.fingerprint.paths, 0.35)

  // Concrete overlap is stronger evidence than wording alone. Preserve the
  // active cache when the new request still names/localizes to the same file
  // or symbol.
  if (affinity.pathOverlap > 0 || affinity.symbolOverlap > 0) return false

  // Graph-localized paths are allowed to establish a natural boundary without
  // magic wording, but only when both sides have concrete task identity.
  const disjointConcretePaths = promptPaths.length > 0 && agentPaths.length > 0
  if (disjointConcretePaths && promptTerms.length >= 2) return true

  if (explicitSwitch) {
    // With no concrete path evidence, explicit boundary language can still
    // split a task, but only when lexical affinity is weak. A single generic
    // shared term should not neutralize "separately"; a genuinely similar
    // prompt should remain on the current task.
    return promptTerms.length >= 2
      && affinity.termOverlap <= 1
      && affinity.lexicalRatio < 0.34
  }

  // No explicit switch and no disjoint concrete working set means ambiguity.
  // The session router may escalate this narrow band to local embeddings; if
  // that layer is unavailable or low-confidence, staying active remains safe.
  return false
}

function semanticEscalationEligible(
  prompt: string,
  affinity: TaskAffinity,
): boolean {
  const normalized = normalizeText(prompt)
  if (hasCue(normalized, CONTINUATION_CUES) || hasCue(normalized, SWITCH_CUES) || hasCue(normalized, RETURN_CUES)) return false
  const terms = extractTerms(prompt)
  if (terms.length < 2) return false
  if (isStrongMatch(affinity)) return false
  return true
}

function isDormantMatch(affinity: TaskAffinity, normalizedPrompt: string): boolean {
  if (affinity.pathOverlap > 0 || affinity.symbolOverlap > 0) return true
  if (affinity.termOverlap >= 3) return true
  return hasCue(normalizedPrompt, RETURN_CUES) && affinity.termOverlap >= 2
}

function seedFingerprint(agent: TaskAgentState, prompt: string, evidence: TaskAgentEvidence, now: number): void {
  mergeFingerprintSignals(agent.fingerprint.paths, extractPaths(prompt), 0.46, 'prompt', MAX_PATHS, now)
  mergeFingerprintSignals(agent.fingerprint.paths, normalizePaths(evidence.localizedPaths ?? []), 0.58, 'localized', MAX_PATHS, now)
  mergeFingerprintSignals(agent.fingerprint.paths, normalizePaths(evidence.activePaths ?? []), 0.78, 'active', MAX_PATHS, now)
  mergeFingerprintSignals(agent.fingerprint.paths, normalizePaths(evidence.touchedPaths ?? []), 1, 'touched', MAX_PATHS, now)
  mergeFingerprintSignals(agent.fingerprint.symbols, extractSymbols(prompt), 0.46, 'prompt', MAX_SYMBOLS, now)
  mergeFingerprintSignals(agent.fingerprint.symbols, normalizeSymbols(evidence.localizedSymbols ?? []), 0.58, 'localized', MAX_SYMBOLS, now)
  mergeFingerprintSignals(agent.fingerprint.symbols, normalizeSymbols(evidence.recentSymbols ?? []), 0.84, 'symbol', MAX_SYMBOLS, now)
  mergeFingerprintSignals(agent.fingerprint.terms, extractTerms(prompt), 0.32, 'prompt', MAX_TERMS, now)
  agent.fingerprint.revision += 1
}

function commitPromptFingerprint(agent: TaskAgentState, prompt: string, evidence: TaskAgentEvidence, now: number): void {
  if (!prompt && !hasLocalization(evidence)) return
  mergeFingerprintSignals(agent.fingerprint.paths, extractPaths(prompt), 0.46, 'prompt', MAX_PATHS, now)
  mergeFingerprintSignals(agent.fingerprint.paths, normalizePaths(evidence.localizedPaths ?? []), 0.58, 'localized', MAX_PATHS, now)
  mergeFingerprintSignals(agent.fingerprint.symbols, extractSymbols(prompt), 0.46, 'prompt', MAX_SYMBOLS, now)
  mergeFingerprintSignals(agent.fingerprint.symbols, normalizeSymbols(evidence.localizedSymbols ?? []), 0.58, 'localized', MAX_SYMBOLS, now)
  mergeFingerprintSignals(agent.fingerprint.terms, extractTerms(prompt), 0.32, 'prompt', MAX_TERMS, now)
  agent.fingerprint.revision += 1
}

function hasLocalization(evidence: TaskAgentEvidence): boolean {
  return Boolean([...evidence.localizedPaths ?? []].length || [...evidence.localizedSymbols ?? []].length)
}

function emptyFingerprint(): TaskFingerprint {
  return { revision: 0, paths: [], symbols: [], terms: [] }
}

function decayFingerprint(fingerprint: TaskFingerprint): void {
  for (const collection of [fingerprint.paths, fingerprint.symbols, fingerprint.terms]) {
    for (const signal of collection) signal.weight *= FINGERPRINT_DECAY
    for (let index = collection.length - 1; index >= 0; index -= 1) {
      if (collection[index]!.weight < MIN_FINGERPRINT_WEIGHT) collection.splice(index, 1)
    }
  }
}

function mergeFingerprintSignals(
  target: TaskFingerprintSignal[],
  values: Iterable<string>,
  weight: number,
  source: TaskFingerprintSignal['source'],
  limit: number,
  now: number,
): void {
  for (const raw of values) {
    const value = String(raw).trim()
    if (!value) continue
    const existing = target.find((signal) => signal.value === value)
    if (existing) {
      // Repeated evidence asymptotically reinforces the signal without letting
      // weak prompt mentions instantly outrank verified/touched activity.
      existing.weight = Math.min(1, Math.max(existing.weight, weight) + Math.min(existing.weight, weight) * 0.12)
      if (weight >= existing.weight || source === 'touched') existing.source = source
      existing.updatedAt = now
    } else {
      target.push({ value, weight, source, updatedAt: now })
    }
  }
  target.sort((left, right) => left.weight - right.weight || left.updatedAt - right.updatedAt)
  if (target.length > limit) target.splice(0, target.length - limit)
}

function weightedOverlapScore(query: Set<string>, signals: TaskFingerprintSignal[]): number {
  let score = 0
  for (const signal of signals) if (query.has(signal.value)) score += signal.weight
  return score
}

function strongValues(signals: TaskFingerprintSignal[], minimum: number): string[] {
  return signals.filter((signal) => signal.weight >= minimum).map((signal) => signal.value)
}

function strongest(signals: TaskFingerprintSignal[], limit: number): TaskFingerprintSignal[] {
  return [...signals]
    .sort((left, right) => right.weight - left.weight || right.updatedAt - left.updatedAt)
    .slice(0, limit)
}

function renderSignal(signal: TaskFingerprintSignal): string {
  return `${signal.value}(${signal.weight.toFixed(2)})`
}

function agentID(sessionID: string): string {
  return `task:${sessionID}`
}

function cloneAgent(agent: TaskAgentState | undefined): TaskAgentState | undefined {
  if (!agent) return undefined
  return {
    ...agent,
    activePaths: [...agent.activePaths],
    touchedPaths: [...agent.touchedPaths],
    recentSymbols: [...agent.recentSymbols],
    terms: [...agent.terms],
    fingerprint: {
      revision: agent.fingerprint.revision,
      paths: agent.fingerprint.paths.map((signal) => ({ ...signal })),
      symbols: agent.fingerprint.symbols.map((signal) => ({ ...signal })),
      terms: agent.fingerprint.terms.map((signal) => ({ ...signal })),
    },
    stalePaths: [...agent.stalePaths],
  }
}

function emptyAffinity(): TaskAffinity {
  return { score: 0, pathOverlap: 0, symbolOverlap: 0, termOverlap: 0, lexicalRatio: 0, weightedOverlap: 0 }
}

function overlapCount(left: Set<string>, right: Set<string>): number {
  let count = 0
  for (const value of left) if (right.has(value)) count += 1
  return count
}

function extractTerms(value: string): string[] {
  const normalized = normalizeText(value)
  const terms = normalized.match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []
  return boundedUnique(terms.filter((term) => !STOP_TERMS.has(term) && !looksLikePath(term)), MAX_TERMS)
}

function extractPaths(value: string): string[] {
  const matches = value.match(/(?:\.?\.?\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+(?:\.[A-Za-z0-9_-]+)?|[A-Za-z0-9_.@-]+\.(?:ts|tsx|js|jsx|rs|py|go|java|json|md|yaml|yml|toml|css|html)/g) ?? []
  return boundedUnique(normalizePaths(matches), MAX_PATHS)
}

function extractSymbols(value: string): string[] {
  const symbols = value.match(/\b(?:[A-Z][A-Za-z0-9]{2,}|[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)\b/g) ?? []
  return boundedUnique(normalizeSymbols(symbols), MAX_SYMBOLS)
}

function normalizePaths(values: Iterable<string>): string[] {
  const output: string[] = []
  for (const value of values) {
    let path = String(value).trim().replaceAll('\\', '/').replace(/^\.\//, '')
    path = path.replace(/[),.;:'"\]}>]+$/g, '')
    if (!path || path.startsWith('http://') || path.startsWith('https://') || path.length > 512) continue
    output.push(path.toLowerCase())
  }
  return output
}

function normalizeSymbols(values: Iterable<string>): string[] {
  return [...values].map((value) => String(value).trim().toLowerCase()).filter(Boolean)
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

function hasCue(value: string, cues: readonly string[]): boolean {
  return cues.some((cue) => value.includes(cue))
}

function looksLikePath(value: string): boolean {
  return value.includes('/') || /\.[a-z0-9]{1,8}$/.test(value)
}

function mergeRecent(existing: string[], incoming: Iterable<string>, limit: number): string[] {
  return boundedUnique([...existing, ...incoming], limit)
}

function boundedUnique(values: Iterable<string>, limit: number): string[] {
  const output: string[] = []
  for (const raw of values) {
    const value = String(raw).trim()
    if (!value) continue
    const index = output.indexOf(value)
    if (index >= 0) output.splice(index, 1)
    output.push(value)
    if (output.length > limit) output.splice(0, output.length - limit)
  }
  return output
}

function boundedDescriptor(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (Buffer.byteLength(normalized) <= MAX_DESCRIPTOR_BYTES) return normalized
  let end = MAX_DESCRIPTOR_BYTES
  while (end > 0 && Buffer.byteLength(normalized.slice(0, end)) > MAX_DESCRIPTOR_BYTES) end -= 1
  return normalized.slice(0, end)
}
