import { CuppetController } from '../controller.js'
import type { AgentEvent, SessionInfo, TokenUsage } from '../types.js'
import { TaskSessionRouter, type PreparedTaskSession } from './session-router.js'

export type Pe3Snapshot = {
  activeAgent?: ReturnType<TaskSessionRouter['agents']>[number]
  agents: ReturnType<TaskSessionRouter['agents']>
  routing: ReturnType<TaskSessionRouter['stats']>
  cachedInput: number
  uncachedInput: number
  cacheWrite: number
  providerAdjustedCost: number
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

  constructor(options: ConstructorParameters<typeof CuppetController>[0]) {
    super(options)
    this.onAgentEvent((event) => this.#observeTaskEvent(event))
  }

  override async initialize(): Promise<void> {
    await super.initialize()
    const session = this.snapshot.activeSession
    if (session) this.#taskSessions.bindSession(session.id, this.#taskEvidence())
  }

  override async newSession(): Promise<SessionInfo> {
    const session = await super.newSession()
    this.#taskSessions.bindSession(session.id, this.#taskEvidence())
    return session
  }

  override async resume(sessionID: string): Promise<SessionInfo> {
    const session = await super.resume(sessionID)
    this.#taskSessions.bindSession(session.id, this.#taskEvidence())
    return session
  }

  override async adoptSession(sessionID: string): Promise<SessionInfo> {
    const session = await super.adoptSession(sessionID)
    if (session.agent !== 'cuppet-background') {
      this.#taskSessions.bindSession(session.id, this.#taskEvidence())
    }
    return session
  }

  override async submit(prompt: string, delivery: 'queue' | 'steer' = 'queue'): Promise<void> {
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
    })

    await super.submit(prepared.prompt, delivery)
  }

  override async status(): Promise<Record<string, unknown>> {
    const status = await super.status()
    return {
      ...status,
      pe3: this.pe3Snapshot(),
    }
  }

  pe3Snapshot(): Pe3Snapshot {
    const usage = this.snapshot.foregroundUsage
    const cachedInput = boundedCachedInput(usage)
    const agents = this.#taskSessions.agents()
    return {
      ...(this.#taskSessions.active ? { activeAgent: this.#taskSessions.active } : {}),
      agents,
      routing: this.#taskSessions.stats(),
      cachedInput,
      uncachedInput: Math.max(0, usage.input - cachedInput),
      cacheWrite: Math.max(0, usage.cacheWrite),
      // OpenCode's usage event already reports provider-calculated cost. Do
      // not invent a cache discount when provider pricing metadata does not
      // expose one separately.
      providerAdjustedCost: Math.max(0, this.snapshot.foregroundCost),
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

  #observeTaskEvent(event: AgentEvent): void {
    if (event.type === 'tool-end' && event.success && event.outputPaths?.length) {
      this.#taskSessions.noteActivePaths(event.outputPaths)
      if (event.diff) this.#taskSessions.noteWorkspaceMutation(event.outputPaths)
      return
    }

    if (event.type === 'diff') {
      const paths = pathsFromDiff(event.diff)
      if (paths.length > 0) this.#taskSessions.noteWorkspaceMutation(paths)
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

function pathsFromDiff(diff: unknown): string[] {
  let text = ''
  try {
    text = typeof diff === 'string' ? diff : JSON.stringify(diff)
  } catch {
    return []
  }
  const matches = text.match(/(?:\.?\.?\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+(?:\.[A-Za-z0-9_-]+)?|[A-Za-z0-9_.@-]+\.(?:ts|tsx|js|jsx|rs|py|go|java|json|md|yaml|yml|toml|css|html)/g) ?? []
  return [...new Set(matches.map((path) => path.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase()))].slice(0, 16)
}
