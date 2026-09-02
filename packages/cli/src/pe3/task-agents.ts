const MAX_TERMS = 32
const MAX_PATHS = 16
const MAX_SYMBOLS = 16
const MAX_DESCRIPTOR_BYTES = 320

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
  workspaceEpoch?: number
}

export type TaskAgentState = {
  id: string
  sessionID: string
  taskDescriptor: string
  activePaths: string[]
  touchedPaths: string[]
  recentSymbols: string[]
  terms: string[]
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
}

export type TaskRoute =
  | { action: 'continue'; agent: TaskAgentState; reason: string; affinity: TaskAffinity }
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
      stalePaths: [],
      cacheEpoch: 0,
      workspaceEpoch: Math.max(this.#workspaceEpoch, evidence.workspaceEpoch ?? 0),
      createdAt: now,
      lastActiveAt: now,
      turns: prompt.trim() ? 1 : 0,
    }
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

    this.#mergeEvidence(active, evidence)
    const currentAffinity = affinityFor(active, prompt)
    const normalizedPrompt = normalizeText(prompt)
    const explicitSwitch = hasCue(normalizedPrompt, SWITCH_CUES)
    const explicitReturn = hasCue(normalizedPrompt, RETURN_CUES)
    const dormant = this.#bestDormantMatch(active, prompt, normalizedPrompt)

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

    if (!isStrongMismatch(active, prompt, currentAffinity, explicitSwitch)) {
      return {
        action: 'continue',
        agent: cloneAgent(active) as TaskAgentState,
        reason: 'ambiguous or weak mismatch stays on the active agent',
        affinity: currentAffinity,
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
    if (trimmed) {
      active.taskDescriptor = boundedDescriptor(trimmed)
      active.terms = mergeRecent(active.terms, extractTerms(trimmed), MAX_TERMS)
      active.activePaths = mergeRecent(active.activePaths, extractPaths(trimmed), MAX_PATHS)
      active.recentSymbols = mergeRecent(active.recentSymbols, extractSymbols(trimmed), MAX_SYMBOLS)
      active.turns += 1
    }
    this.#mergeEvidence(active, evidence)
    active.lastActiveAt = this.#now()
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
    }
  }

  acknowledgeRefresh(agentIDValue: string, paths: Iterable<string>): void {
    const agent = this.#agents.get(agentIDValue)
    if (!agent) return
    const refreshed = new Set(normalizePaths(paths))
    if (refreshed.size === 0) return
    agent.stalePaths = agent.stalePaths.filter((path) => !refreshed.has(path))
  }

  #mergeEvidence(agent: TaskAgentState, evidence: TaskAgentEvidence): void {
    agent.activePaths = mergeRecent(agent.activePaths, normalizePaths(evidence.activePaths ?? []), MAX_PATHS)
    agent.touchedPaths = mergeRecent(agent.touchedPaths, normalizePaths(evidence.touchedPaths ?? []), MAX_PATHS)
    agent.recentSymbols = mergeRecent(agent.recentSymbols, normalizeSymbols(evidence.recentSymbols ?? []), MAX_SYMBOLS)
    if (evidence.workspaceEpoch !== undefined) {
      agent.workspaceEpoch = Math.max(agent.workspaceEpoch, evidence.workspaceEpoch)
      this.#workspaceEpoch = Math.max(this.#workspaceEpoch, evidence.workspaceEpoch)
    }
  }

  #bestDormantMatch(
    active: TaskAgentState,
    prompt: string,
    normalizedPrompt: string,
  ): { agent: TaskAgentState; affinity: TaskAffinity } | undefined {
    return [...this.#agents.values()]
      .filter((agent) => agent.id !== active.id)
      .map((agent) => ({ agent, affinity: affinityFor(agent, prompt) }))
      .filter(({ affinity }) => isDormantMatch(affinity, normalizedPrompt))
      .sort((left, right) =>
        right.affinity.score - left.affinity.score || right.agent.lastActiveAt - left.agent.lastActiveAt,
      )[0]
  }
}

function affinityFor(agent: TaskAgentState, prompt: string): TaskAffinity {
  const paths = new Set(extractPaths(prompt))
  const symbols = new Set(extractSymbols(prompt))
  const terms = new Set(extractTerms(prompt))
  const agentPaths = new Set([...agent.activePaths, ...agent.touchedPaths])
  const agentSymbols = new Set(agent.recentSymbols)
  const agentTerms = new Set(agent.terms)
  const pathOverlap = overlapCount(paths, agentPaths)
  const symbolOverlap = overlapCount(symbols, agentSymbols)
  const termOverlap = overlapCount(terms, agentTerms)
  const denominator = Math.max(1, Math.min(terms.size, agentTerms.size))
  const lexicalRatio = termOverlap / denominator
  return {
    score: pathOverlap * 8 + symbolOverlap * 5 + termOverlap,
    pathOverlap,
    symbolOverlap,
    termOverlap,
    lexicalRatio,
  }
}

function isStrongMatch(affinity: TaskAffinity): boolean {
  return affinity.pathOverlap > 0
    || affinity.symbolOverlap > 0
    || affinity.termOverlap >= 2
    || affinity.lexicalRatio >= 0.34
}

function isStrongMismatch(
  agent: TaskAgentState,
  prompt: string,
  affinity: TaskAffinity,
  explicitSwitch = hasCue(normalizeText(prompt), SWITCH_CUES),
): boolean {
  const promptTerms = extractTerms(prompt)
  const promptPaths = extractPaths(prompt)
  const agentPaths = [...agent.activePaths, ...agent.touchedPaths]

  // Concrete overlap is stronger evidence than wording alone. Preserve the
  // active cache when the new request still names the same file or symbol.
  if (affinity.pathOverlap > 0 || affinity.symbolOverlap > 0) return false

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
  // Stay on the active agent instead of guessing from raw prompt length.
  return false
}

function isDormantMatch(affinity: TaskAffinity, normalizedPrompt: string): boolean {
  if (affinity.pathOverlap > 0 || affinity.symbolOverlap > 0) return true
  if (affinity.termOverlap >= 3) return true
  return hasCue(normalizedPrompt, RETURN_CUES) && affinity.termOverlap >= 2
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
    stalePaths: [...agent.stalePaths],
  }
}

function emptyAffinity(): TaskAffinity {
  return { score: 0, pathOverlap: 0, symbolOverlap: 0, termOverlap: 0, lexicalRatio: 0 }
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