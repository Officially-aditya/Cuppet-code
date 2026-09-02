const MAX_TERMS = 32
const MAX_PATHS = 16
const MAX_SYMBOLS = 16
const MAX_DESCRIPTOR_BYTES = 320
const FINGERPRINT_DECAY = 0.96
const MIN_FINGERPRINT_WEIGHT = 0.08
const STRONG_LEXICAL_WEIGHT = 0.9
const MIME_PATH = /^(?:application|audio|font|image|message|model|multipart|text|video)\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,127}$/i

const CONTINUATION_CUES = ['also', 'that', 'those', 'the previous', 'same task', 'same issue', 'continue', 'keep going', 'update the tests', 'fix the tests', 'what about']
const SWITCH_CUES = ['new task', 'separate task', 'separately', 'unrelated', 'instead', 'switch to', 'now build', 'now implement', 'move on to']
const RETURN_CUES = ['go back to', 'return to', 'back to', 'resume the', 'resume that', 'previous task', 'earlier task']
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

const FINGERPRINT_SOURCE_STRENGTH: Record<TaskFingerprintSignal['source'], number> = {
  prompt: 0,
  localized: 1,
  active: 2,
  symbol: 2,
  touched: 3,
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

export type TaskAgentRouterCheckpoint = {
  agents: TaskAgentState[]
  activeID?: string
  workspaceEpoch: number
}

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

  checkpoint(): TaskAgentRouterCheckpoint {
    return {
      agents: [...this.#agents.values()].map((agent) => cloneAgent(agent) as TaskAgentState),
      ...(this.#activeID ? { activeID: this.#activeID } : {}),
      workspaceEpoch: this.#workspaceEpoch,
    }
  }

  restoreCheckpoint(checkpoint: TaskAgentRouterCheckpoint): void {
    this.#agents.clear()
    for (const agent of checkpoint.agents) {
      const restored = cloneAgent(agent) as TaskAgentState
      restored.id = agentID(restored.sessionID)
      this.#agents.set(restored.id, restored)
    }
    this.#workspaceEpoch = checkpoint.workspaceEpoch
    this.#activeID = checkpoint.activeID && this.#agents.has(checkpoint.activeID)
      ? checkpoint.activeID
      : undefined
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

  restore(state: TaskAgentState): TaskAgentState {
    const restored = cloneAgent(state) as TaskAgentState
    restored.id = agentID(restored.sessionID)
    this.#agents.set(restored.id, restored)
    this.#workspaceEpoch = Math.max(this.#workspaceEpoch, restored.workspaceEpoch)
    return cloneAgent(restored) as TaskAgentState
  }

  select(agentIDValue: string): TaskAgentState | undefined {
    const state = this.#agents.get(agentIDValue)
    if (!state) return undefined
    this.#activeID = state.id
    return cloneAgent(state) as TaskAgentState
  }

  activate(agentIDValue: string): TaskAgentState | undefined {
    const state = this.#agents.get(agentIDValue)
    if (!state) return undefined
    this.#activeID = state.id
    state.lastActiveAt = this.#now()
    return cloneAgent(state) as TaskAgentState
  }

  recordSessionEvidence(sessionID: string, evidence: TaskAgentEvidence): TaskAgentState | undefined {
    const state = this.#agents.get(agentID(sessionID))
    if (!state) return undefined
    this.#mergeObservedEvidence(state, evidence)
    return cloneAgent(state) as TaskAgentState
  }

  acknowledgeSessionRefresh(sessionID: string, paths: Iterable<string>): void {
    this.acknowledgeRefresh(agentID(sessionID), paths)
  }

  route(prompt: string, evidence: TaskAgentEvidence = {}): TaskRoute {
    const active = this.#activeID ? this.#agents.get(this.#activeID) : undefined
    if (!active) return { action: 'create', reason: 'no active task agent', affinity: emptyAffinity() }
    this.#mergeObservedEvidence(active, evidence)
    const currentAffinity = affinityFor(active, prompt, evidence)
    const normalizedPrompt = normalizeText(prompt)
    const explicitSwitch = hasCue(normalizedPrompt, SWITCH_CUES)
    const explicitReturn = hasCue(normalizedPrompt, RETURN_CUES)
    const dormant = this.#bestDormantMatch(active, prompt, normalizedPrompt, evidence)

    if (hasCue(normalizedPrompt, CONTINUATION_CUES)) {
      return { action: 'continue', agent: cloneAgent(active) as TaskAgentState, reason: 'continuation language defaults to the active agent', affinity: currentAffinity }
    }
    if (explicitReturn && dormant) {
      return { action: 'reactivate', agent: cloneAgent(dormant.agent) as TaskAgentState, reason: 'explicit return language matches a dormant task agent', affinity: dormant.affinity, refreshPaths: [...dormant.agent.stalePaths] }
    }
    if (!explicitSwitch && isStrongMatch(currentAffinity)) {
      return { action: 'continue', agent: cloneAgent(active) as TaskAgentState, reason: 'active working-set affinity is sufficient', affinity: currentAffinity }
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
      return { action: 'reactivate', agent: cloneAgent(dormant.agent) as TaskAgentState, reason: 'strong active mismatch with a matching dormant task agent', affinity: dormant.affinity, refreshPaths: [...dormant.agent.stalePaths] }
    }
    return { action: 'create', reason: 'strong task mismatch with no matching dormant agent', affinity: currentAffinity }
  }

  recordTurn(prompt: string, evidence: TaskAgentEvidence = {}): TaskAgentState | undefined {
    const active = this.#activeID ? this.#agents.get(this.#activeID) : undefined
    if (!active) return undefined
    const trimmed = prompt.trim()
    const now = this.#now()
    if (trimmed) {
      const promptTerms = extractTerms(trimmed)
      const promptPaths = extractPaths(trimmed)
      const promptSymbols = extractSymbols(trimmed)
      const hasPromptEvidence = promptTerms.length > 0 || promptPaths.length > 0 || promptSymbols.length > 0
      if (hasPromptEvidence) {
        active.taskDescriptor = boundedDescriptor(trimmed)
        active.terms = mergeRecent(active.terms, promptTerms, MAX_TERMS)
        active.activePaths = mergeRecent(active.activePaths, promptPaths, MAX_PATHS)
        active.recentSymbols = mergeRecent(active.recentSymbols, promptSymbols, MAX_SYMBOLS)
        decayFingerprint(active.fingerprint)
      }
      active.turns += 1
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
    if (activePaths.length > 0 || touchedPaths.length > 0 || recentSymbols.length > 0) agent.fingerprint.revision += 1
    if (evidence.workspaceEpoch !== undefined) {
      agent.workspaceEpoch = Math.max(agent.workspaceEpoch, evidence.workspaceEpoch)
      this.#workspaceEpoch = Math.max(this.#workspaceEpoch, evidence.workspaceEpoch)
    }
  }

  #bestDormantMatch(active: TaskAgentState, prompt: string, normalizedPrompt: string, evidence: TaskAgentEvidence): { agent: TaskAgentState; affinity: TaskAffinity } | undefined {
    return [...this.#agents.values()]
      .filter((agent) => agent.id !== active.id)
      .map((agent) => ({ agent, affinity: affinityFor(agent, prompt, evidence) }))
      .filter(({ affinity }) => isDormantMatch(affinity, normalizedPrompt))
      .sort((left, right) => right.affinity.score - left.affinity.score || right.agent.lastActiveAt - left.agent.lastActiveAt)[0]
  }
}

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
  const paths = new Set([...extractPaths(prompt), ...normalizePaths(evidence.localizedPaths ?? [])])
  const symbols = new Set([...extractSymbols(prompt), ...normalizeSymbols(evidence.localizedSymbols ?? [])])
  const terms = new Set(extractTerms(prompt))
  const agentPaths = new Set(strongValues(agent.fingerprint.paths, 0.35))
  const agentSymbols = new Set(strongValues(agent.fingerprint.symbols, 0.35))
  const agentTerms = new Set(strongValues(agent.fingerprint.terms, 0.12))
  const pathOverlap = overlapCount(paths, agentPaths)
  const symbolOverlap = overlapCount(symbols, agentSymbols)
  const termOverlap = overlapCount(terms, agentTerms)
  const denominator = Math.max(1, Math.min(terms.size, agentTerms.size))
  const lexicalRatio = termOverlap / denominator
  const weightedOverlap = weightedOverlapScore(paths, agent.fingerprint.paths) * 8 + weightedOverlapScore(symbols, agent.fingerprint.symbols) * 5 + weightedOverlapScore(terms, agent.fingerprint.terms)
  return { score: weightedOverlap, pathOverlap, symbolOverlap, termOverlap, lexicalRatio, weightedOverlap }
}

function isStrongMatch(affinity: TaskAffinity): boolean {
  if (affinity.pathOverlap > 0 || affinity.symbolOverlap > 0) return true
  return affinity.weightedOverlap >= STRONG_LEXICAL_WEIGHT && (affinity.termOverlap >= 3 || affinity.lexicalRatio >= 0.6)
}

function isStrongMismatch(agent: TaskAgentState, prompt: string, affinity: TaskAffinity, evidence: TaskAgentEvidence, explicitSwitch = hasCue(normalizeText(prompt), SWITCH_CUES)): boolean {
  const promptTerms = extractTerms(prompt)
  const promptPaths = boundedUnique([...extractPaths(prompt), ...normalizePaths(evidence.localizedPaths ?? [])], MAX_PATHS)
  const agentPaths = strongValues(agent.fingerprint.paths, 0.35)
  if (affinity.pathOverlap > 0 || affinity.symbolOverlap > 0) return false
  if (promptPaths.length > 0 && agentPaths.length > 0 && promptTerms.length >= 2) return true
  if (explicitSwitch) return promptTerms.length >= 2 && affinity.termOverlap <= 1 && affinity.lexicalRatio < 0.34
  return false
}

function semanticEscalationEligible(prompt: string, affinity: TaskAffinity): boolean {
  const normalized = normalizeText(prompt)
  if (hasCue(normalized, CONTINUATION_CUES) || hasCue(normalized, SWITCH_CUES) || hasCue(normalized, RETURN_CUES)) return false
  const terms = extractTerms(prompt)
  if (terms.length < 2 || isStrongMatch(affinity)) return false
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
  const promptPaths = extractPaths(prompt)
  const localizedPaths = normalizePaths(evidence.localizedPaths ?? [])
  const promptSymbols = extractSymbols(prompt)
  const localizedSymbols = normalizeSymbols(evidence.localizedSymbols ?? [])
  const promptTerms = extractTerms(prompt)
  if (promptPaths.length === 0 && localizedPaths.length === 0 && promptSymbols.length === 0 && localizedSymbols.length === 0 && promptTerms.length === 0) return
  mergeFingerprintSignals(agent.fingerprint.paths, promptPaths, 0.46, 'prompt', MAX_PATHS, now)
  mergeFingerprintSignals(agent.fingerprint.paths, localizedPaths, 0.58, 'localized', MAX_PATHS, now)
  mergeFingerprintSignals(agent.fingerprint.symbols, promptSymbols, 0.46, 'prompt', MAX_SYMBOLS, now)
  mergeFingerprintSignals(agent.fingerprint.symbols, localizedSymbols, 0.58, 'localized', MAX_SYMBOLS, now)
  mergeFingerprintSignals(agent.fingerprint.terms, promptTerms, 0.32, 'prompt', MAX_TERMS, now)
  agent.fingerprint.revision += 1
}

function emptyFingerprint(): TaskFingerprint { return { revision: 0, paths: [], symbols: [], terms: [] } }

function decayFingerprint(fingerprint: TaskFingerprint): void {
  for (const collection of [fingerprint.paths, fingerprint.symbols, fingerprint.terms]) {
    for (const signal of collection) signal.weight *= FINGERPRINT_DECAY
    for (let index = collection.length - 1; index >= 0; index -= 1) if (collection[index]!.weight < MIN_FINGERPRINT_WEIGHT) collection.splice(index, 1)
  }
}

function mergeFingerprintSignals(target: TaskFingerprintSignal[], values: Iterable<string>, weight: number, source: TaskFingerprintSignal['source'], limit: number, now: number): void {
  for (const raw of values) {
    const value = String(raw).trim()
    if (!value) continue
    const existing = target.find((signal) => signal.value === value)
    if (existing) {
      const previousSource = existing.source
      existing.weight = Math.min(1, Math.max(existing.weight, weight) + Math.min(existing.weight, weight) * 0.12)
      if (FINGERPRINT_SOURCE_STRENGTH[source] > FINGERPRINT_SOURCE_STRENGTH[previousSource]) existing.source = source
      existing.updatedAt = now
    } else target.push({ value, weight, source, updatedAt: now })
  }
  target.sort((left, right) => left.weight - right.weight || left.updatedAt - right.updatedAt)
  if (target.length > limit) target.splice(0, target.length - limit)
}

function weightedOverlapScore(query: Set<string>, signals: TaskFingerprintSignal[]): number {
  let score = 0
  for (const signal of signals) if (query.has(signal.value)) score += signal.weight
  return score
}
function strongValues(signals: TaskFingerprintSignal[], minimum: number): string[] { return signals.filter((signal) => signal.weight >= minimum).map((signal) => signal.value) }
function strongest(signals: TaskFingerprintSignal[], limit: number): TaskFingerprintSignal[] { return [...signals].sort((left, right) => right.weight - left.weight || right.updatedAt - left.updatedAt).slice(0, limit) }
function renderSignal(signal: TaskFingerprintSignal): string { return `${signal.value}(${signal.weight.toFixed(2)})` }
function agentID(sessionID: string): string { return `task:${sessionID}` }

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

function emptyAffinity(): TaskAffinity { return { score: 0, pathOverlap: 0, symbolOverlap: 0, termOverlap: 0, lexicalRatio: 0, weightedOverlap: 0 } }
function overlapCount(left: Set<string>, right: Set<string>): number { let count = 0; for (const value of left) if (right.has(value)) count += 1; return count }
function extractTerms(value: string): string[] { const normalized = normalizeText(value); const terms = normalized.match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []; return boundedUnique(terms.filter((term) => !STOP_TERMS.has(term) && !looksLikePath(term)), MAX_TERMS) }
function extractPaths(value: string): string[] { const matches = value.match(/(?:\.?\.?\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+(?:\.[A-Za-z0-9_-]+)?|[A-Za-z0-9_.@-]+\.(?:ts|tsx|js|jsx|rs|py|go|java|json|md|yaml|yml|toml|css|html)/g) ?? []; return boundedUnique(normalizePaths(matches), MAX_PATHS) }
function extractSymbols(value: string): string[] { const symbols = value.match(/\b(?:[A-Z][A-Za-z0-9]{2,}|[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)\b/g) ?? []; return boundedUnique(normalizeSymbols(symbols), MAX_SYMBOLS) }
function normalizePaths(values: Iterable<string>): string[] { const output: string[] = []; for (const value of values) { let path = String(value).trim().replaceAll('\\', '/').replace(/^\.\//, ''); path = path.replace(/[),.;:'"\]}>]+$/g, ''); if (!path || path.startsWith('http://') || path.startsWith('https://') || path.length > 512 || looksLikeMimeType(path)) continue; output.push(path.toLowerCase()) } return output }
function normalizeSymbols(values: Iterable<string>): string[] { return [...values].map((value) => String(value).trim().toLowerCase()).filter(Boolean) }
function normalizeText(value: string): string { return value.toLowerCase().replace(/\s+/g, ' ').trim() }
function hasCue(value: string, cues: readonly string[]): boolean { return cues.some((cue) => value.includes(cue)) }
function looksLikePath(value: string): boolean { return value.includes('/') || /\.[a-z0-9]{1,8}$/.test(value) }
function looksLikeMimeType(value: string): boolean { return MIME_PATH.test(value) }
function mergeRecent(existing: string[], incoming: Iterable<string>, limit: number): string[] { return boundedUnique([...existing, ...incoming], limit) }
function boundedUnique(values: Iterable<string>, limit: number): string[] { const output: string[] = []; for (const raw of values) { const value = String(raw).trim(); if (!value) continue; const index = output.indexOf(value); if (index >= 0) output.splice(index, 1); output.push(value); if (output.length > limit) output.splice(0, output.length - limit) } return output }
function boundedDescriptor(value: string): string { const normalized = value.trim().replace(/\s+/g, ' '); if (Buffer.byteLength(normalized) <= MAX_DESCRIPTOR_BYTES) return normalized; let end = MAX_DESCRIPTOR_BYTES; while (end > 0 && Buffer.byteLength(normalized.slice(0, end)) > MAX_DESCRIPTOR_BYTES) end -= 1; return normalized.slice(0, end) }
