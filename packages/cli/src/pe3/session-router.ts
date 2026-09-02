import {
  TaskAgentRouter,
  type TaskAffinity,
  type TaskAgentEvidence,
  type TaskAgentRouterCheckpoint,
  type TaskAgentState,
  type TaskRoute,
} from './task-agents.js'
import type { TaskLocalizationEvidence, TaskLocalizationMetadata } from './localizer.js'
import { LocalTransformersEmbeddingProvider } from './local-embedding.js'
import {
  SemanticTaskRouter,
  type SemanticRouteDecision,
} from './semantic-router.js'

export type TaskSessionRef = { id: string }

export type TaskSessionAdapter = {
  current: () => TaskSessionRef | undefined
  create: () => Promise<TaskSessionRef>
  resume: (sessionID: string) => Promise<TaskSessionRef>
  evidence: () => TaskAgentEvidence
  localize?: (sessionID: string, prompt: string) => Promise<TaskLocalizationEvidence>
}

export type TaskSessionPrepareOptions = {
  /** Additional bounded context visible only to semantic escalation. */
  semanticContext?: string
}

export type PreparedTaskSession = {
  action: 'continue' | 'create' | 'reactivate'
  sessionID: string
  prompt: string
  reason: string
  refreshPaths: string[]
  affinity?: TaskAffinity
}

export type TaskSessionRoutingStats = {
  sequence: number
  continuations: number
  created: number
  reactivated: number
  switches: number
  localizationQueries: number
  localizationHits: number
  localizationDecisive: number
  localizationWeak: number
  lastLocalizationTopScore?: number
  lastLocalizationRunnerUpScore?: number
  lastLocalizationReason?: string
  semanticEscalations: number
  semanticContinuations: number
  semanticCreated: number
  semanticReactivated: number
  semanticFallbacks: number
  semanticFailures: number
  semanticPromptEmbeddings: number
  semanticAgentEmbeddings: number
  semanticEmbeddingLatencyMs: number
  semanticEmbeddingLatencyMaxMs: number
  semanticModelID?: string
  lastSemanticActiveSimilarity?: number
  lastSemanticDormantSimilarity?: number
  lastAction?: PreparedTaskSession['action']
  lastReason?: string
}

export type TaskSessionRouterCheckpoint = {
  router: TaskAgentRouterCheckpoint
  stats: TaskSessionRoutingStats
}

export type TaskSessionRouterOptions = { semantic?: SemanticTaskRouter | false }

export class TaskSessionRouter {
  readonly #router: TaskAgentRouter
  readonly #semantic: SemanticTaskRouter | undefined
  #stats: TaskSessionRoutingStats = emptyRoutingStats()

  constructor(router = new TaskAgentRouter(), options: TaskSessionRouterOptions = {}) {
    this.#router = router
    this.#semantic = options.semantic === false ? undefined : options.semantic ?? new SemanticTaskRouter(new LocalTransformersEmbeddingProvider())
  }

  get active(): TaskAgentState | undefined { return this.#router.active }
  agents(): TaskAgentState[] { return this.#router.list() }
  stats(): TaskSessionRoutingStats { return { ...this.#stats } }

  checkpoint(): TaskSessionRouterCheckpoint {
    return {
      router: this.#router.checkpoint(),
      stats: this.stats(),
    }
  }

  restoreCheckpoint(checkpoint: TaskSessionRouterCheckpoint): void {
    this.#router.restoreCheckpoint(checkpoint.router)
    this.#stats = { ...checkpoint.stats }
  }

  bindSession(sessionID: string, evidence: TaskAgentEvidence = {}, descriptor = ''): TaskAgentState {
    const activated = this.#router.activate(taskAgentID(sessionID))
    if (activated) return activated
    return this.#router.register(sessionID, descriptor, evidence)
  }

  restoreAgent(state: TaskAgentState): TaskAgentState {
    return this.#router.restore(state)
  }

  selectRestoredSession(sessionID: string): TaskAgentState | undefined {
    return this.#router.select(taskAgentID(sessionID))
  }

  async prepare(
    prompt: string,
    adapter: TaskSessionAdapter,
    options: TaskSessionPrepareOptions = {},
  ): Promise<PreparedTaskSession> {
    let evidence = adapter.evidence()
    let current = adapter.current()
    if (!current) {
      current = await adapter.create()
      this.bindSession(current.id, evidence)
      this.#router.recordTurn(prompt, evidence)
      return this.#record({ action: 'create', sessionID: current.id, prompt, reason: 'no active session; created initial task-local agent', refreshPaths: [] })
    }

    this.bindSession(current.id, evidence)
    const active = this.#router.active
    if (!active || active.turns === 0) {
      this.#router.recordTurn(prompt, evidence)
      return this.#record({ action: 'continue', sessionID: current.id, prompt, reason: 'first turn seeds the active task agent', refreshPaths: [] })
    }

    let route = this.#router.route(prompt, evidence)
    if (route.action === 'continue' && isHardExplicitSwitchPrompt(prompt)) {
      const dormantPath = findDormantPathMatch(prompt, active, this.#router.list())
      if (dormantPath) {
        route = {
          action: 'reactivate',
          agent: dormantPath.agent,
          reason: 'explicit switch path matches a dormant task agent',
          affinity: pathMatchAffinity(dormantPath.overlap),
          refreshPaths: [...dormantPath.agent.stalePaths],
        }
      } else if (shouldForceExplicitSwitch(prompt, active, route.affinity)) {
        route = {
          action: 'create',
          reason: 'explicit task-switch intent has no active structural match or dormant path target',
          affinity: route.affinity,
        }
      }
    }

    if (route.action === 'continue' && route.semanticEligible && adapter.localize) {
      this.#stats.localizationQueries += 1
      const localized = await adapter.localize(current.id, prompt).catch(() => ({} as TaskLocalizationEvidence))
      this.#recordLocalization(localized.localization)
      if (hasLocalizedEvidence(localized)) {
        this.#stats.localizationHits += 1
        evidence = mergeEvidence(evidence, localized)
        route = this.#router.route(prompt, evidence)
      }
    }

    const semanticReturnOnly = route.action === 'continue' && isExplicitReturnPrompt(prompt)
    const semanticContextEligible = route.action === 'continue'
      && semanticContextEscalationEligible(prompt, route.affinity, options.semanticContext)
    if (
      route.action === 'continue'
      && (route.semanticEligible || semanticReturnOnly || semanticContextEligible)
      && this.#semantic
    ) {
      route = await this.#semanticRoute(prompt, route, semanticReturnOnly, options.semanticContext)
    }

    if (route.action === 'continue') {
      this.#router.recordTurn(prompt, evidence)
      return this.#record({ action: 'continue', sessionID: current.id, prompt, reason: route.reason, refreshPaths: [], affinity: route.affinity })
    }

    const transitionEvidence = mergeTransitionEvidence(adapter.evidence(), evidence)
    if (route.action === 'reactivate') {
      const resumed = await adapter.resume(route.agent.sessionID)
      this.bindSession(resumed.id)
      this.#router.recordTurn(prompt, transitionEvidence)
      return this.#record({ action: 'reactivate', sessionID: resumed.id, prompt: withRefreshHint(prompt, route.refreshPaths), reason: route.reason, refreshPaths: [...route.refreshPaths], affinity: route.affinity })
    }

    const created = await adapter.create()
    this.bindSession(created.id, transitionEvidence)
    this.#router.recordTurn(prompt, transitionEvidence)
    return this.#record({ action: 'create', sessionID: created.id, prompt, reason: route.reason, refreshPaths: [], affinity: route.affinity })
  }

  noteSessionObservedPaths(sessionID: string, paths: Iterable<string>): void {
    const bounded = [...paths]
    if (bounded.length === 0) return
    this.#router.recordSessionEvidence(sessionID, { activePaths: bounded })
    this.#router.acknowledgeSessionRefresh(sessionID, bounded)
  }

  noteSessionPaths(sessionID: string, paths: Iterable<string>): void {
    this.noteSessionObservedPaths(sessionID, paths)
  }

  noteSessionWorkspaceMutation(sessionID: string, paths: Iterable<string>): void {
    const bounded = [...paths]
    if (bounded.length === 0) return
    this.#router.recordSessionEvidence(sessionID, { activePaths: bounded, touchedPaths: bounded })
    this.#router.noteWorkspaceChange(bounded)
    this.#router.acknowledgeSessionRefresh(sessionID, bounded)
  }

  noteActivePaths(paths: Iterable<string>): void { const active = this.#router.active; if (active) this.noteSessionObservedPaths(active.sessionID, paths) }
  noteWorkspaceMutation(paths: Iterable<string>): void { const active = this.#router.active; if (active) this.noteSessionWorkspaceMutation(active.sessionID, paths) }

  async #semanticRoute(
    prompt: string,
    deterministic: Extract<TaskRoute, { action: 'continue' }>,
    returnOnly = false,
    semanticContext = '',
  ): Promise<TaskRoute> {
    const active = this.#router.active
    if (!active || !this.#semantic) return deterministic
    const dormant = this.#router.list().filter((agent) => agent.id !== active.id)
    this.#stats.semanticEscalations += 1
    const decision = await this.#semantic.decide(semanticInput(prompt, semanticContext), active, dormant)
    this.#recordSemantic(decision)
    if (decision.action === 'reactivate' && decision.agent) {
      return { action: 'reactivate', agent: decision.agent, reason: decision.reason, affinity: deterministic.affinity, refreshPaths: [...decision.agent.stalePaths] }
    }
    if (decision.action === 'create') {
      if (returnOnly) return { ...deterministic, reason: 'explicit return had no decisive dormant semantic match; preserve the active task', semanticEligible: false }
      return { action: 'create', reason: decision.reason, affinity: deterministic.affinity }
    }
    return { ...deterministic, reason: decision.reason, semanticEligible: false }
  }

  #recordLocalization(localization: TaskLocalizationMetadata | undefined): void {
    if (!localization) {
      delete this.#stats.lastLocalizationTopScore
      delete this.#stats.lastLocalizationRunnerUpScore
      delete this.#stats.lastLocalizationReason
      return
    }
    this.#stats.lastLocalizationTopScore = localization.topScore
    if (localization.runnerUpScore !== undefined) this.#stats.lastLocalizationRunnerUpScore = localization.runnerUpScore
    else delete this.#stats.lastLocalizationRunnerUpScore
    this.#stats.lastLocalizationReason = localization.reason
    if (localization.decisive) this.#stats.localizationDecisive += 1
    else this.#stats.localizationWeak += 1
  }

  #recordSemantic(decision: SemanticRouteDecision): void {
    this.#stats.semanticModelID = decision.modelID
    this.#stats.semanticPromptEmbeddings += decision.promptEmbeddingCount
    this.#stats.semanticAgentEmbeddings += decision.agentEmbeddingCount
    this.#stats.semanticEmbeddingLatencyMs += decision.embeddingLatencyMs
    this.#stats.semanticEmbeddingLatencyMaxMs = Math.max(this.#stats.semanticEmbeddingLatencyMaxMs, decision.embeddingLatencyMs)
    this.#stats.lastSemanticActiveSimilarity = decision.activeSimilarity
    if (decision.bestDormantSimilarity !== undefined) this.#stats.lastSemanticDormantSimilarity = decision.bestDormantSimilarity
    else delete this.#stats.lastSemanticDormantSimilarity
    if (decision.fallback) this.#stats.semanticFallbacks += 1
    if (decision.error) this.#stats.semanticFailures += 1
    if (decision.action === 'continue') this.#stats.semanticContinuations += 1
    if (decision.action === 'create') this.#stats.semanticCreated += 1
    if (decision.action === 'reactivate') this.#stats.semanticReactivated += 1
  }

  #record(result: PreparedTaskSession): PreparedTaskSession {
    this.#stats.sequence += 1
    if (result.action === 'continue') this.#stats.continuations += 1
    if (result.action === 'create') this.#stats.created += 1
    if (result.action === 'reactivate') this.#stats.reactivated += 1
    if (result.action !== 'continue') this.#stats.switches += 1
    this.#stats.lastAction = result.action
    this.#stats.lastReason = result.reason
    return result
  }
}

const ROUTING_PATH_TOKEN = /(?:\.?\.?\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+(?:\.[A-Za-z0-9_-]+)?|[A-Za-z0-9_.@-]+\.(?:ts|tsx|js|jsx|rs|py|go|java|json|md|yaml|yml|toml|css|html)/g
const EXPLICIT_SWITCH_CUES = ['new task', 'separate task', 'separately', 'unrelated', 'instead', 'switch to', 'now build', 'now implement', 'move on to']
const HARD_EXPLICIT_SWITCH_CUES = ['new task', 'separate task', 'separately', 'unrelated', 'switch to', 'move on to']
const CONTINUATION_CUES = ['also', 'that', 'those', 'the previous', 'same task', 'same issue', 'continue', 'keep going', 'update the tests', 'fix the tests', 'what about']

function emptyRoutingStats(): TaskSessionRoutingStats {
  return {
    sequence: 0, continuations: 0, created: 0, reactivated: 0, switches: 0,
    localizationQueries: 0, localizationHits: 0, localizationDecisive: 0, localizationWeak: 0,
    semanticEscalations: 0, semanticContinuations: 0, semanticCreated: 0, semanticReactivated: 0,
    semanticFallbacks: 0, semanticFailures: 0, semanticPromptEmbeddings: 0, semanticAgentEmbeddings: 0,
    semanticEmbeddingLatencyMs: 0, semanticEmbeddingLatencyMaxMs: 0,
  }
}
function taskAgentID(sessionID: string): string { return `task:${sessionID}` }
function withRefreshHint(prompt: string, paths: string[]): string {
  if (paths.length === 0) return prompt
  const bounded = paths.slice(0, 12).join(', ')
  return ['[PE3 task resume]', 'The workspace changed while this task was dormant.', `Before relying on prior file-specific assumptions, refresh these paths from current workspace truth: ${bounded}`, 'Do not assume their previous contents are still current.', '', prompt].join('\n')
}
function normalizedPrompt(prompt: string): string { return prompt.toLowerCase().replace(/\s+/g, ' ').trim() }
function hasCue(prompt: string, cues: readonly string[]): boolean { const normalized = normalizedPrompt(prompt); return cues.some((cue) => normalized.includes(cue)) }
function isExplicitReturnPrompt(prompt: string): boolean {
  return hasCue(prompt, ['go back to', 'return to', 'back to', 'resume the', 'resume that', 'previous task', 'earlier task'])
}
function isExplicitSwitchPrompt(prompt: string): boolean { return hasCue(prompt, EXPLICIT_SWITCH_CUES) }
function isHardExplicitSwitchPrompt(prompt: string): boolean { return hasCue(prompt, HARD_EXPLICIT_SWITCH_CUES) }
function hasContinuationPrompt(prompt: string): boolean { return hasCue(prompt, CONTINUATION_CUES) }
function taskPaths(agent: TaskAgentState): Set<string> {
  return new Set([
    ...agent.activePaths,
    ...agent.touchedPaths,
    ...agent.fingerprint.paths.map((signal) => signal.value),
  ].map(normalizeRoutingPath).filter(Boolean))
}
function shouldForceExplicitSwitch(prompt: string, active: TaskAgentState, affinity: TaskAffinity): boolean {
  if (!isHardExplicitSwitchPrompt(prompt)) return false
  if (affinity.pathOverlap > 0 || affinity.symbolOverlap > 0) return false
  const promptPaths = extractRoutingPaths(prompt)
  if (promptPaths.length === 0) return true
  const knownPaths = taskPaths(active)
  return knownPaths.size === 0 || promptPaths.every((path) => !knownPaths.has(path))
}
function findDormantPathMatch(
  prompt: string,
  active: TaskAgentState,
  agents: TaskAgentState[],
): { agent: TaskAgentState; overlap: number } | undefined {
  const promptPaths = extractRoutingPaths(prompt)
  if (promptPaths.length === 0) return undefined
  const candidates = agents
    .filter((agent) => agent.id !== active.id)
    .map((agent) => ({
      agent,
      overlap: promptPaths.filter((path) => taskPaths(agent).has(path)).length,
    }))
    .filter((candidate) => candidate.overlap > 0)
    .sort((left, right) => right.overlap - left.overlap || right.agent.lastActiveAt - left.agent.lastActiveAt)
  const best = candidates[0]
  if (!best) return undefined
  const runnerUp = candidates[1]
  if (runnerUp && runnerUp.overlap === best.overlap) return undefined
  return best
}
function pathMatchAffinity(pathOverlap: number): TaskAffinity {
  return {
    score: pathOverlap * 8,
    pathOverlap,
    symbolOverlap: 0,
    termOverlap: 0,
    lexicalRatio: 0,
    weightedOverlap: pathOverlap,
  }
}
function extractRoutingPaths(prompt: string): string[] {
  return [...new Set((prompt.match(ROUTING_PATH_TOKEN) ?? []).map(normalizeRoutingPath).filter(Boolean))]
}
function normalizeRoutingPath(path: string): string {
  return path.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/[),.;:'"\]}>]+$/g, '').toLowerCase()
}
function semanticContextEscalationEligible(
  prompt: string,
  affinity: TaskAffinity,
  semanticContext: string | undefined,
): boolean {
  if (!semanticContext?.trim()) return false
  if (hasContinuationPrompt(prompt)) return false
  return affinity.pathOverlap === 0 && affinity.symbolOverlap === 0 && affinity.weightedOverlap < 0.9
}
function semanticInput(prompt: string, semanticContext: string): string {
  const context = semanticContext.trim()
  return context ? `${prompt}\n${context}` : prompt
}
function hasLocalizedEvidence(evidence: TaskAgentEvidence): boolean { return iterableHasValues(evidence.localizedPaths) || iterableHasValues(evidence.localizedSymbols) }
function iterableHasValues(values: Iterable<string> | undefined): boolean { if (!values) return false; for (const _value of values) return true; return false }
function mergeEvidence(left: TaskAgentEvidence, right: TaskAgentEvidence): TaskAgentEvidence { return { activePaths: mergeIterables(left.activePaths, right.activePaths), touchedPaths: mergeIterables(left.touchedPaths, right.touchedPaths), recentSymbols: mergeIterables(left.recentSymbols, right.recentSymbols), localizedPaths: mergeIterables(left.localizedPaths, right.localizedPaths), localizedSymbols: mergeIterables(left.localizedSymbols, right.localizedSymbols), workspaceEpoch: Math.max(left.workspaceEpoch ?? 0, right.workspaceEpoch ?? 0) } }
function mergeTransitionEvidence(left: TaskAgentEvidence, right: TaskAgentEvidence): TaskAgentEvidence { return { localizedPaths: mergeIterables(left.localizedPaths, right.localizedPaths), localizedSymbols: mergeIterables(left.localizedSymbols, right.localizedSymbols), workspaceEpoch: Math.max(left.workspaceEpoch ?? 0, right.workspaceEpoch ?? 0) } }
function mergeIterables(left: Iterable<string> | undefined, right: Iterable<string> | undefined): string[] { return [...new Set([...(left ?? []), ...(right ?? [])])] }
