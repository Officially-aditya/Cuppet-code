import { randomUUID } from 'node:crypto'
import { CuppetController } from '../controller.js'
import type { AgentEvent, SessionInfo, TokenUsage } from '../types.js'
import { totalTokenUsage } from '../usage.js'
import { TstTaskLocalizer } from './localizer.js'
import {
  Pe3TaskRegistry,
  restorePersistedTaskAgents,
} from './persistence.js'
import {
  nativeRoutingPrompt,
  nativeSemanticAttachmentText,
  type NativeRoutingAttachment,
} from './native-envelope.js'
import {
  TaskSessionRouter,
  type PreparedTaskSession,
  type TaskSessionRouterCheckpoint,
} from './session-router.js'

const NATIVE_ROUTE_GUARD_MS = 5_000
const NATIVE_ROUTE_TRANSACTION_MS = 30_000

const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })

export type Pe3Snapshot = {
  activeAgent?: ReturnType<TaskSessionRouter['agents']>[number]
  agents: ReturnType<TaskSessionRouter['agents']>
  routing: ReturnType<TaskSessionRouter['stats']>
  cachedInput: number
  uncachedInput: number
  outputTokens: number
  reasoningTokens: number
  cacheWrite: number
  totalModelTokens: number
  providerAdjustedCost: number
  completedTurns: number
  totalLatencyMs: number
  averageLatencyMs: number
  nativeRouteFailures: number
  restoredAgents: number
  droppedPersistedSessions: number
  registryRecoveredFromCorruption: boolean
  registryWriteFailures: number
}

export type NativeTaskRouteResult = {
  rerouted: boolean
  action: PreparedTaskSession['action']
  sourceSessionID: string
  targetSessionID: string
  reason: string
  sequence: number
  refreshPaths: string[]
  routeToken?: string
  forwarded?: boolean
}

type NativeBypass = {
  prompt: string
  expiresAt: number
}

type NativeRouteTransaction = {
  sourceSessionID: string
  targetSessionID: string
  action: Extract<PreparedTaskSession['action'], 'create' | 'reactivate'>
  before: TaskSessionRouterCheckpoint
  after: TaskSessionRouterCheckpoint
  expiresAt: number
}

export class Pe3Controller extends CuppetController {
  readonly #taskSessions = new TaskSessionRouter()
  readonly #taskLocalizer: TstTaskLocalizer
  readonly #taskRegistry: Pe3TaskRegistry
  readonly #nativeBypass = new Map<string, NativeBypass>()
  readonly #suppressedNativeSessions = new Map<string, number>()
  readonly #pendingNativeRoutes = new Map<string, NativeRouteTransaction>()
  readonly #restoredStaleBySession = new Map<string, string[]>()
  readonly #cumulativeUsage = emptyUsage()
  readonly #turnStartedAt = new Map<string, number>()
  #persistTail: Promise<void> = Promise.resolve()
  #registryReady = false
  #cumulativeCost = 0
  #completedTurns = 0
  #totalLatencyMs = 0
  #nativeRouteFailures = 0
  #restoredAgents = 0
  #droppedPersistedSessions = 0
  #registryRecoveredFromCorruption = false
  #registryWriteFailures = 0

  constructor(options: ConstructorParameters<typeof CuppetController>[0]) {
    super(options)
    this.#taskLocalizer = new TstTaskLocalizer(options.tst)
    this.#taskRegistry = new Pe3TaskRegistry(options.paths.projectStore, options.paths.projectRealpath)
    this.onAgentEvent((event) => this.#observeTaskEvent(event))
  }

  override async initialize(): Promise<void> {
    await super.initialize()
    const session = this.snapshot.activeSession
    const sessions = await this.gateway.listSessions().catch(() => [])
    const validSessionIDs = new Set(
      sessions
        .filter((candidate) => candidate.agent !== 'cuppet-background')
        .map((candidate) => candidate.id),
    )
    if (session) validSessionIDs.add(session.id)

    const loaded = await this.#taskRegistry.load(validSessionIDs)
    this.#restoredAgents = loaded.agents.length
    this.#droppedPersistedSessions = loaded.droppedSessionCount
    this.#registryRecoveredFromCorruption = loaded.recoveredFromCorruption
    for (const [sessionID, paths] of loaded.staleBySession) {
      this.#restoredStaleBySession.set(sessionID, [...paths])
    }
    restorePersistedTaskAgents(this.#taskSessions, loaded, session?.id)

    if (session && !this.#taskSessions.agents().some((agent) => agent.sessionID === session.id)) {
      this.#taskSessions.bindSession(session.id, this.#taskEvidence())
    }
    this.#registryReady = true
    await this.#persistRegistry()
  }

  override async close(): Promise<void> {
    if (this.#registryReady) await this.#persistRegistry()
    await this.#persistTail
    await super.close()
  }

  override async newSession(): Promise<SessionInfo> {
    const session = await super.newSession()
    this.#taskSessions.bindSession(session.id, this.#taskEvidence())
    this.#schedulePersist()
    return session
  }

  override async resume(sessionID: string): Promise<SessionInfo> {
    const session = await super.resume(sessionID)
    this.#taskSessions.bindSession(session.id, this.#taskEvidence())
    this.#schedulePersist()
    return session
  }

  override async adoptSession(sessionID: string): Promise<SessionInfo> {
    const suppressedUntil = this.#suppressedNativeSessions.get(sessionID)
    if (suppressedUntil && suppressedUntil > Date.now()) return this.gateway.getSession(sessionID)
    if (suppressedUntil) this.#suppressedNativeSessions.delete(sessionID)
    const session = await super.adoptSession(sessionID)
    if (session.agent !== 'cuppet-background') {
      this.#taskSessions.bindSession(session.id, this.#taskEvidence())
      this.#schedulePersist()
    }
    return session
  }

  override async submit(prompt: string, delivery: 'queue' | 'steer' = 'queue'): Promise<void> {
    const prepared = await this.#prepareTaskSession(prompt)
    this.#schedulePersist()
    this.#armNativeBypass(prepared.sessionID, prepared.prompt)
    this.#turnStartedAt.set(prepared.sessionID, Date.now())
    await super.submit(prepared.prompt, delivery)
  }

  async routeNativePrompt(
    sessionID: string,
    prompt: string,
    attachments: NativeRoutingAttachment[] = [],
  ): Promise<NativeTaskRouteResult> {
    this.#expireNativeGuards()
    const bypass = this.#nativeBypass.get(sessionID)
    if (attachments.length === 0 && bypass && bypass.expiresAt > Date.now() && bypass.prompt === prompt) {
      this.#nativeBypass.delete(sessionID)
      return {
        rerouted: false,
        action: 'continue',
        sourceSessionID: sessionID,
        targetSessionID: sessionID,
        reason: 'controller-forwarded prompt already passed PE3 routing',
        sequence: this.#taskSessions.stats().sequence,
        refreshPaths: [],
        forwarded: true,
      }
    }

    const source = await super.adoptSession(sessionID)
    if (source.agent === 'cuppet-background') {
      return {
        rerouted: false,
        action: 'continue',
        sourceSessionID: sessionID,
        targetSessionID: sessionID,
        reason: 'background sessions are outside PE3 foreground routing',
        sequence: this.#taskSessions.stats().sequence,
        refreshPaths: [],
      }
    }
    this.#taskSessions.bindSession(source.id)
    const before = this.#taskSessions.checkpoint()

    let prepared: PreparedTaskSession
    try {
      prepared = await this.#prepareTaskSession(
        nativeRoutingPrompt(prompt, attachments),
        nativeSemanticAttachmentText(attachments),
      )
    } catch (error) {
      this.#taskSessions.restoreCheckpoint(before)
      await super.resume(source.id).catch(() => undefined)
      this.#nativeRouteFailures += 1
      throw error
    }

    if (prepared.action === 'continue') {
      if (prepared.sessionID !== sessionID) throw new Error('PE3 continue route changed the active session unexpectedly')
      this.#schedulePersist()
      this.#turnStartedAt.set(sessionID, Date.now())
      return {
        rerouted: false,
        action: 'continue',
        sourceSessionID: sessionID,
        targetSessionID: sessionID,
        reason: prepared.reason,
        sequence: this.#taskSessions.stats().sequence,
        refreshPaths: [...prepared.refreshPaths],
      }
    }

    const after = this.#taskSessions.checkpoint()
    this.#taskSessions.restoreCheckpoint(before)
    try {
      await super.resume(source.id)
    } catch (error) {
      this.#nativeRouteFailures += 1
      throw error
    }

    const routeToken = randomUUID()
    this.#pendingNativeRoutes.set(routeToken, {
      sourceSessionID: source.id,
      targetSessionID: prepared.sessionID,
      action: prepared.action,
      before,
      after,
      expiresAt: Date.now() + NATIVE_ROUTE_TRANSACTION_MS,
    })

    return {
      rerouted: true,
      action: prepared.action,
      sourceSessionID: sessionID,
      targetSessionID: prepared.sessionID,
      reason: prepared.reason,
      sequence: after.stats.sequence,
      refreshPaths: [...prepared.refreshPaths],
      routeToken,
    }
  }

  async commitNativeRoute(routeToken: string): Promise<{ committed: true; targetSessionID: string }> {
    this.#expireNativeGuards()
    const transaction = this.#pendingNativeRoutes.get(routeToken)
    if (!transaction) throw new Error('native PE3 route token is missing or expired')

    await super.resume(transaction.targetSessionID)
    this.#taskSessions.restoreCheckpoint(transaction.after)
    this.#pendingNativeRoutes.delete(routeToken)
    this.#suppressedNativeSessions.set(transaction.sourceSessionID, Date.now() + NATIVE_ROUTE_GUARD_MS)
    this.#turnStartedAt.set(transaction.targetSessionID, Date.now())
    this.#schedulePersist()
    return { committed: true, targetSessionID: transaction.targetSessionID }
  }

  async abortNativeRoute(routeToken: string): Promise<{ aborted: true; sourceSessionID: string }> {
    this.#expireNativeGuards()
    const transaction = this.#pendingNativeRoutes.get(routeToken)
    if (!transaction) throw new Error('native PE3 route token is missing or expired')

    this.#pendingNativeRoutes.delete(routeToken)
    this.#taskSessions.restoreCheckpoint(transaction.before)
    if (this.snapshot.activeSession?.id !== transaction.sourceSessionID) {
      await super.resume(transaction.sourceSessionID)
    }
    if (transaction.action === 'create') {
      await this.gateway.interrupt(transaction.targetSessionID).catch(() => undefined)
    }
    this.#turnStartedAt.delete(transaction.targetSessionID)
    this.#suppressedNativeSessions.delete(transaction.sourceSessionID)
    this.#nativeRouteFailures += 1
    this.#schedulePersist()
    return { aborted: true, sourceSessionID: transaction.sourceSessionID }
  }

  override async status(): Promise<Record<string, unknown>> {
    const status = await super.status()
    return { ...status, pe3: this.pe3Snapshot() }
  }

  pe3Snapshot(): Pe3Snapshot {
    const cachedInput = boundedCachedInput(this.#cumulativeUsage)
    const agents = this.#taskSessions.agents()
    return {
      ...(this.#taskSessions.active ? { activeAgent: this.#taskSessions.active } : {}),
      agents,
      routing: this.#taskSessions.stats(),
      cachedInput,
      uncachedInput: Math.max(0, this.#cumulativeUsage.input - cachedInput),
      outputTokens: this.#cumulativeUsage.output,
      reasoningTokens: this.#cumulativeUsage.reasoning,
      cacheWrite: Math.max(0, this.#cumulativeUsage.cacheWrite),
      totalModelTokens: totalTokenUsage(this.#cumulativeUsage),
      providerAdjustedCost: Math.max(0, this.#cumulativeCost),
      completedTurns: this.#completedTurns,
      totalLatencyMs: this.#totalLatencyMs,
      averageLatencyMs: this.#completedTurns > 0 ? this.#totalLatencyMs / this.#completedTurns : 0,
      nativeRouteFailures: this.#nativeRouteFailures,
      restoredAgents: this.#restoredAgents,
      droppedPersistedSessions: this.#droppedPersistedSessions,
      registryRecoveredFromCorruption: this.#registryRecoveredFromCorruption,
      registryWriteFailures: this.#registryWriteFailures,
    }
  }

  async #prepareTaskSession(prompt: string, semanticContext = ''): Promise<PreparedTaskSession> {
    const prepared = await this.#taskSessions.prepare(prompt, {
      current: () => {
        const session = this.snapshot.activeSession
        return session ? { id: session.id } : undefined
      },
      create: async () => {
        const session = await super.newSession()
        return { id: session.id }
      },
      resume: async (sessionID) => {
        const session = await super.resume(sessionID)
        return { id: session.id }
      },
      evidence: () => this.#taskEvidence(),
      localize: (sessionID, value) => this.#taskLocalizer.locate(sessionID, value),
    }, { semanticContext })
    return this.#withRestoredRefreshGuard(prepared)
  }

  #withRestoredRefreshGuard(prepared: PreparedTaskSession): PreparedTaskSession {
    const restoredStale = this.#restoredStaleBySession.get(prepared.sessionID) ?? []
    if (restoredStale.length === 0) return prepared
    const refreshPaths = [...new Set([...prepared.refreshPaths, ...restoredStale])].slice(0, 16)
    return {
      ...prepared,
      refreshPaths,
      prompt: withPersistedRefreshHint(prepared.prompt, restoredStale),
    }
  }

  #armNativeBypass(sessionID: string, prompt: string): void {
    this.#nativeBypass.set(sessionID, { prompt, expiresAt: Date.now() + NATIVE_ROUTE_GUARD_MS })
  }

  #expireNativeGuards(): void {
    const now = Date.now()
    for (const [sessionID, bypass] of this.#nativeBypass) {
      if (bypass.expiresAt <= now) this.#nativeBypass.delete(sessionID)
    }
    for (const [sessionID, expiresAt] of this.#suppressedNativeSessions) {
      if (expiresAt <= now) this.#suppressedNativeSessions.delete(sessionID)
    }
    for (const [routeToken, transaction] of this.#pendingNativeRoutes) {
      if (transaction.expiresAt > now) continue
      this.#pendingNativeRoutes.delete(routeToken)
      this.#nativeRouteFailures += 1
      if (transaction.action === 'create') {
        void this.gateway.interrupt(transaction.targetSessionID).catch(() => undefined)
      }
    }
  }

  #taskEvidence() {
    const session = this.snapshot.activeSession
    const active = this.#taskSessions.active
    return { ...(session ? { workspaceEpoch: active?.workspaceEpoch ?? 0 } : {}) }
  }

  #clearRestoredStale(sessionID: string, paths: Iterable<string>): void {
    const current = this.#restoredStaleBySession.get(sessionID)
    if (!current?.length) return
    const refreshed = new Set([...paths].map((path) => normalizePath(path)))
    const remaining = current.filter((path) => !refreshed.has(normalizePath(path)))
    if (remaining.length > 0) this.#restoredStaleBySession.set(sessionID, remaining)
    else this.#restoredStaleBySession.delete(sessionID)
  }

  #schedulePersist(): void {
    if (!this.#registryReady) return
    this.#persistTail = this.#persistTail.then(() => this.#persistRegistry()).catch(() => undefined)
  }

  async #persistRegistry(): Promise<void> {
    try {
      await this.#taskRegistry.save(
        this.#taskSessions.agents(),
        this.snapshot.activeSession?.id,
        this.#restoredStaleBySession,
      )
    } catch {
      this.#registryWriteFailures += 1
    }
  }

  #observeTaskEvent(event: AgentEvent): void {
    if (event.type === 'usage') {
      this.#cumulativeUsage.input += event.usage.input
      this.#cumulativeUsage.output += event.usage.output
      this.#cumulativeUsage.reasoning += event.usage.reasoning
      this.#cumulativeUsage.cacheRead += event.usage.cacheRead
      this.#cumulativeUsage.cacheWrite += event.usage.cacheWrite
      this.#cumulativeCost += event.cost
    }

    if (event.type === 'idle') {
      const startedAt = this.#turnStartedAt.get(event.sessionID)
      if (startedAt !== undefined) {
        this.#turnStartedAt.delete(event.sessionID)
        this.#completedTurns += 1
        this.#totalLatencyMs += Math.max(0, Date.now() - startedAt)
      }
      this.#schedulePersist()
    }

    if (event.type === 'tool-end' && event.success && event.outputPaths?.length) {
      if (event.diff) this.#taskSessions.noteSessionWorkspaceMutation(event.sessionID, event.outputPaths)
      else this.#taskSessions.noteSessionObservedPaths(event.sessionID, event.outputPaths)
      this.#clearRestoredStale(event.sessionID, event.outputPaths)
      this.#schedulePersist()
      return
    }

    if (event.type === 'diff') {
      const paths = pathsFromDiff(event.diff)
      if (paths.length > 0) {
        this.#taskSessions.noteSessionWorkspaceMutation(event.sessionID, paths)
        this.#clearRestoredStale(event.sessionID, paths)
        this.#schedulePersist()
      }
    }
  }
}

export function pe3InputBreakdown(usage: TokenUsage): {
  cachedInput: number
  uncachedInput: number
  cacheWrite: number
} {
  const cachedInput = boundedCachedInput(usage)
  return {
    cachedInput,
    uncachedInput: Math.max(0, usage.input - cachedInput),
    cacheWrite: Math.max(0, usage.cacheWrite),
  }
}

export function routeChangedSession(route: PreparedTaskSession, previousSessionID?: string): boolean {
  return Boolean(previousSessionID && route.sessionID !== previousSessionID)
}

function boundedCachedInput(usage: TokenUsage): number {
  return Math.max(0, Math.min(usage.input, usage.cacheRead))
}

function withPersistedRefreshHint(prompt: string, paths: string[]): string {
  if (paths.length === 0) return prompt
  const bounded = paths.slice(0, 12).join(', ')
  return [
    '[PE3 persisted task resume]',
    'This task was restored after a Cuppet restart and the workspace changed while it was offline.',
    `Refresh these paths from current workspace truth before relying on prior file-specific assumptions: ${bounded}`,
    '',
    prompt,
  ].join('\n')
}

function pathsFromDiff(diff: unknown): string[] {
  let text = ''
  try {
    text = typeof diff === 'string' ? diff : JSON.stringify(diff)
  } catch {
    return []
  }
  const matches = text.match(/(?:\.?\.?\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+(?:\.[A-Za-z0-9_-]+)?|[A-Za-z0-9_.@-]+\.(?:ts|tsx|js|jsx|rs|py|go|java|json|md|yaml|yml|toml|css|html)/g) ?? []
  return [...new Set(matches.map(normalizePath))].slice(0, 16)
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase()
}
