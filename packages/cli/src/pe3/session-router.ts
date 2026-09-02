import {
  TaskAgentRouter,
  type TaskAffinity,
  type TaskAgentEvidence,
  type TaskAgentState,
} from './task-agents.js'

export type TaskSessionRef = { id: string }

export type TaskSessionAdapter = {
  current: () => TaskSessionRef | undefined
  create: () => Promise<TaskSessionRef>
  resume: (sessionID: string) => Promise<TaskSessionRef>
  evidence: () => TaskAgentEvidence
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
  lastAction?: PreparedTaskSession['action']
  lastReason?: string
}

/**
 * Maps deterministic task-agent decisions onto inert OpenCode sessions.
 *
 * It deliberately knows nothing about models or prompts beyond routing. The
 * caller owns model execution. A dormant session therefore consumes no model
 * tokens until `prepare()` explicitly reactivates it.
 */
export class TaskSessionRouter {
  readonly #router: TaskAgentRouter
  readonly #stats: TaskSessionRoutingStats = {
    sequence: 0,
    continuations: 0,
    created: 0,
    reactivated: 0,
    switches: 0,
  }

  constructor(router = new TaskAgentRouter()) {
    this.#router = router
  }

  get active(): TaskAgentState | undefined {
    return this.#router.active
  }

  agents(): TaskAgentState[] {
    return this.#router.list()
  }

  stats(): TaskSessionRoutingStats {
    return { ...this.#stats }
  }

  bindSession(sessionID: string, evidence: TaskAgentEvidence = {}, descriptor = ''): TaskAgentState {
    const activated = this.#router.activate(taskAgentID(sessionID))
    if (activated) return activated
    return this.#router.register(sessionID, descriptor, evidence)
  }

  async prepare(prompt: string, adapter: TaskSessionAdapter): Promise<PreparedTaskSession> {
    const evidence = adapter.evidence()
    let current = adapter.current()

    if (!current) {
      current = await adapter.create()
      this.bindSession(current.id, evidence)
      this.#router.recordTurn(prompt, evidence)
      return this.#record({
        action: 'create',
        sessionID: current.id,
        prompt,
        reason: 'no active session; created initial task-local agent',
        refreshPaths: [],
      })
    }

    this.bindSession(current.id, evidence)
    const active = this.#router.active
    // A newly created/resumed session has no established task descriptor yet.
    // The first prompt must seed it rather than immediately triggering a split.
    if (!active || active.turns === 0) {
      this.#router.recordTurn(prompt, evidence)
      return this.#record({
        action: 'continue',
        sessionID: current.id,
        prompt,
        reason: 'first turn seeds the active task agent',
        refreshPaths: [],
      })
    }

    const route = this.#router.route(prompt, evidence)
    if (route.action === 'continue') {
      this.#router.recordTurn(prompt, evidence)
      return this.#record({
        action: 'continue',
        sessionID: current.id,
        prompt,
        reason: route.reason,
        refreshPaths: [],
        affinity: route.affinity,
      })
    }

    if (route.action === 'reactivate') {
      const resumed = await adapter.resume(route.agent.sessionID)
      this.bindSession(resumed.id, adapter.evidence())
      this.#router.recordTurn(prompt, adapter.evidence())
      return this.#record({
        action: 'reactivate',
        sessionID: resumed.id,
        prompt: withRefreshHint(prompt, route.refreshPaths),
        reason: route.reason,
        refreshPaths: [...route.refreshPaths],
        affinity: route.affinity,
      })
    }

    const created = await adapter.create()
    this.bindSession(created.id, adapter.evidence())
    this.#router.recordTurn(prompt, adapter.evidence())
    return this.#record({
      action: 'create',
      sessionID: created.id,
      prompt,
      reason: route.reason,
      refreshPaths: [],
      affinity: route.affinity,
    })
  }

  noteActivePaths(paths: Iterable<string>): void {
    const bounded = [...paths]
    if (bounded.length === 0) return
    this.#router.recordTurn('', {
      activePaths: bounded,
      touchedPaths: bounded,
    })
    const active = this.#router.active
    if (active) this.#router.acknowledgeRefresh(active.id, bounded)
  }

  noteWorkspaceMutation(paths: Iterable<string>): void {
    const bounded = [...paths]
    if (bounded.length === 0) return
    // Record the active task's knowledge of its own mutation first. The
    // mutation then invalidates every task-local view that privileged the path,
    // after which the active task immediately acknowledges its own fresh view.
    this.noteActivePaths(bounded)
    this.#router.noteWorkspaceChange(bounded)
    const active = this.#router.active
    if (active) this.#router.acknowledgeRefresh(active.id, bounded)
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

function taskAgentID(sessionID: string): string {
  return `task:${sessionID}`
}

function withRefreshHint(prompt: string, paths: string[]): string {
  if (paths.length === 0) return prompt
  const bounded = paths.slice(0, 12).join(', ')
  return [
    '[PE3 task resume]',
    'The workspace changed while this task was dormant.',
    `Before relying on prior file-specific assumptions, refresh these paths from current workspace truth: ${bounded}`,
    'Do not assume their previous contents are still current.',
    '',
    prompt,
  ].join('\n')
}
