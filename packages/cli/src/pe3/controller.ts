import { CuppetController } from '../controller.js'
import type { AgentEvent, SessionInfo, TokenUsage } from '../types.js'
import { totalTokenUsage } from '../usage.js'
import { TstTaskLocalizer } from './localizer.js'
import {
  Pe3TaskRegistry,
  restorePersistedTaskAgents,
} from './persistence.js'
import { nativeRoutingPrompt, type NativeRoutingAttachment } from './native-envelope.js'
import { TaskSessionRouter, type PreparedTaskSession } from './session-router.js'

const NATIVE_ROUTE_GUARD_MS = 5_000

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
  forwarded?: boolean
}

type NativeBypass = {
  prompt: string
  expiresAt: number
}

/**
 * PE3 foreground controller.
 *
 * The base controller remains the source of truth for OpenCode/TST behavior.
 * This wrapper only chooses which existing OpenCode session should receive a
 * new user turn. Same-task turns flow through `super.submit()` unchanged,
 * preserving the provider-cache-friendly path.
 */
export class Pe3Controller extends CuppetController {
  readonly #taskSessions = new TaskSessionRouter()
  readonly #taskLocalizer: TstTaskLocalizer
  readonly #taskRegistry: Pe3TaskRegistry
  readonly #nativeBypass = new Map<string, NativeBypass>()
  readonly #suppressedNativeSessions = new Map<string, number>()
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
    if (suppressedUntil && suppressedUntil > Date.now()) {
      // A routed native request still emits source-session bookkeeping events.
      // Read them without allowing those delayed events to steal active-agent
      // privilege back from the routed target session.
      return this.gateway.getSession(sessionID)
    }
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

  /**
   * Pre-inference routing entrypoint used by the bundled OpenCode derivative.
   *
   * Native OpenCode owns the authoritative prompt parts, including attachment
   * URLs/payloads. PE3 receives only bounded text + file metadata, chooses the
   * target task session, and returns that decision. The derivative forwards the
   * original parts losslessly and writes only a no-reply marker to the source.
   */
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

    // A real native user request is authoritative even if late bookkeeping
    // events from an earlier reroute temporarily suppress event-driven adoption.
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

    const prepared = await this.#prepareTaskSession(nativeRoutingPrompt(prompt, attachments))
    this.#schedulePersist()
    if (prepared.action === 'continue' && prepared.sessionID === sessionID) {
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

    // Do not submit here. Native OpenCode still owns the original parts and is
    // the only layer capable of forwarding attachment URLs/data losslessly.
    this.#suppressedNativeSessions.set(sessionID, Date.now() + NATIVE_ROUTE_GUARD_MS)
    this.#turnStartedAt.set(prepared.sessionID, Date.now())

    return {
      rerouted: true,
      action: prepared.action,
      sourceSessionID: sessionID,
      targetSessionID: prepared.sessionID,
      reason: prepared.reason,
      sequence: this.#taskSessions.stats().sequence,
      refreshPaths: [...prepared.refreshPaths],
    }
  }

  override async status(): Promise<Record<string, unknown>> {
    const status = await super.status()
    return {
      ...status,
      pe3: this.pe3Snapshot(),
    }
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
      // Usage events contain the provider-calculated request cost, including
      // provider-specific cache pricing when OpenCode exposes it. Accumulating
      // those events across task sessions preserves effective-cost accounting.
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

  async #prepareTaskSession(prompt: string): Promise<PreparedTaskSession> {
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
    })
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
    this.#nativeBypass.set(sessionID, {
      prompt,
      expiresAt: Date.now() + NATIVE_ROUTE_GUARD_MS,
    })
  }

  #expireNativeGuards(): void {
    const now = Date.now()
    for (const [sessionID, bypass] of this.#nativeBypass) {
      if (bypass.expiresAt <= now) this.#nativeBypass.delete(sessionID)
    }
    for (const [sessionID, expiresAt] of this.#suppressedNativeSessions) {
      if (expiresAt <= now) this.#suppressedNativeSessions.delete(sessionID)
    }
  }

  #taskEvidence() {
    const session = this.snapshot.activeSession
    const active = this.#taskSessions.active
    return {
      activePaths: active?.activePaths ?? [],
      touchedPaths: active?.touchedPaths ?? [],
      recentSymbols: active?.recentSymbols ?? [],
      ...(session ? { workspaceEpoch: active?.workspaceEpoch ?? 0 } : {}),
    }
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
    this.#persistTail = this.#persistTail
      .then(() => this.#persistRegistry())
      .catch(() => undefined)
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
      this.#taskSessions.noteActivePaths(event.outputPaths)
      this.#clearRestoredStale(event.sessionID, event.outputPaths)
      if (event.diff) this.#taskSessions.noteWorkspaceMutation(event.outputPaths)
      this.#schedulePersist()
      return
    }

    if (event.type === 'diff') {
      const paths = pathsFromDiff(event.diff)
      if (paths.length > 0) {
        this.#taskSessions.noteWorkspaceMutation(paths)
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
