import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { createOpencodeClient } from '@opencode-ai/sdk/v2'
import type {
  IntegrationInfo as SDKIntegrationInfo,
  ModelV2Info,
  Provider as LegacyProvider,
  ProviderAuthMethod,
  Session as LegacySession,
} from '@opencode-ai/sdk/v2'
import type {
  AgentEvent,
  IntegrationInfo,
  IntegrationMethod,
  ModelInfo,
  ModelRef,
  SessionInfo,
  TokenUsage,
} from '../types.js'

type Client = ReturnType<typeof createOpencodeClient>
type SdkResult<T> = { data?: T; error?: unknown; response?: Response }

type OAuthAttempt = {
  providerID: string
  method: number
  status: 'pending' | 'complete' | 'failed' | 'cancelled'
  message?: string
  abort: AbortController
}

type StreamPart = {
  sessionID: string
  messageID: string
  kind?: 'text' | 'reasoning'
  text: string
  emitted: number
}

export type OpenCodeGatewayAgents = {
  foreground?: string
  background?: string
}

/**
 * OpenCode 1.18.4 exposes the complete live catalog through v2, but its new
 * native runner only implements a subset of the provider adapters. The stable
 * session API on the same server is the compatibility execution path used by
 * OpenCode itself and supports Google, Vertex, Azure, Anthropic, and OpenAI.
 */
export class OpenCodeGateway extends EventEmitter {
  readonly #client: Client
  readonly #directory: string
  readonly #eventAbort = new AbortController()
  readonly #normalizer = new OpenCodeEventNormalizer()
  readonly #sessionModels = new Map<string, ModelRef>()
  readonly #backgroundSessions = new Set<string>()
  readonly #oauthAttempts = new Map<string, OAuthAttempt>()
  readonly #foregroundAgent: string
  readonly #backgroundAgent: string
  #eventTask?: Promise<void>

  constructor(client: Client, directory: string, agents: OpenCodeGatewayAgents = {}) {
    super()
    this.#client = client
    this.#directory = directory
    this.#foregroundAgent = agents.foreground ?? 'cuppet'
    this.#backgroundAgent = agents.background ?? 'cuppet-background'
  }

  startEvents(): void {
    if (this.#eventTask) return
    this.#eventTask = this.#consumeEvents().catch((error) => {
      if (!this.#eventAbort.signal.aborted) this.emit('event', { type: 'error', message: message(error) } satisfies AgentEvent)
    })
  }

  async close(): Promise<void> {
    for (const attempt of this.#oauthAttempts.values()) attempt.abort.abort()
    this.#eventAbort.abort()
    await this.#eventTask?.catch(() => undefined)
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.on('event', listener)
    return () => this.off('event', listener)
  }

  async listModels(): Promise<ModelInfo[]> {
    const [modernResponse, legacyResponse] = await Promise.all([
      this.#client.v2.model.list({ location: { directory: this.#directory } }),
      this.#client.provider.list({ directory: this.#directory }),
    ])
    const modern = unwrap(modernResponse as SdkResult<{ data: ModelV2Info[] }>).data
    const legacy = unwrap(legacyResponse as SdkResult<{
      all: LegacyProvider[]
      connected: string[]
    }>)
    const connected = new Set(legacy.connected)
    const providers = new Map(legacy.all.map((provider) => [provider.id, provider]))
    const selections = new Map<string, ModelInfo>()

    for (const model of modern) {
      const executable = providers.get(model.providerID)?.models[model.id]
      if (!executable || !connected.has(model.providerID)) continue
      const cost = model.cost[0]
      for (const variant of [undefined, ...model.variants.map((item) => item.id)]) {
        const info: ModelInfo = {
          providerID: model.providerID,
          modelID: model.id,
          ...(variant ? { variant } : {}),
          name: `${model.name}${variant ? ` [${variant}]` : ''}`,
          context: model.limit.context,
          output: model.limit.output,
          enabled: true,
          status: model.status,
          inputCost: cost?.input ?? 0,
          outputCost: cost?.output ?? 0,
          capabilities: {
            tools: model.capabilities.tools,
            input: [...model.capabilities.input],
            output: [...model.capabilities.output],
          },
        }
        selections.set(modelKey(info), info)
      }
    }

    // Do not lose an executable provider model if the v2 projection is behind
    // the provider catalog. This remains live OpenCode data, not a hard-coded
    // Cuppet model list.
    for (const provider of legacy.all) {
      if (!connected.has(provider.id)) continue
      for (const model of Object.values(provider.models)) {
        for (const variant of [undefined, ...Object.keys(model.variants ?? {})]) {
          const key = modelKey({ providerID: provider.id, modelID: model.id, ...(variant ? { variant } : {}) })
          if (selections.has(key)) continue
          selections.set(key, {
            providerID: provider.id,
            modelID: model.id,
            ...(variant ? { variant } : {}),
            name: `${model.name}${variant ? ` [${variant}]` : ''}`,
            context: model.limit.context,
            output: model.limit.output,
            enabled: true,
            status: model.status,
            inputCost: model.cost.input,
            outputCost: model.cost.output,
            capabilities: {
              tools: model.capabilities.toolcall,
              input: enabledModalities(model.capabilities.input),
              output: enabledModalities(model.capabilities.output),
            },
          })
        }
      }
    }

    return [...selections.values()].filter((model) => model.status !== 'deprecated')
  }

  async listIntegrations(): Promise<IntegrationInfo[]> {
    const [modernResult, providerResult, authResult] = await Promise.all([
      this.#client.v2.integration.list({ location: { directory: this.#directory } }),
      this.#client.provider.list({ directory: this.#directory }),
      this.#client.provider.auth({ directory: this.#directory }),
    ])
    const modern = unwrap(modernResult as SdkResult<{ data: SDKIntegrationInfo[] }>).data
    const providers = unwrap(providerResult as SdkResult<{
      all: LegacyProvider[]
      connected: string[]
    }>)
    const auth = unwrap(authResult as SdkResult<Record<string, ProviderAuthMethod[]>>)
    const connected = new Set(providers.connected)
    const byID = new Map<string, IntegrationInfo>()

    for (const integration of modern) {
      byID.set(integration.id, {
        id: integration.id,
        name: integration.name,
        // OAuth must persist into the stable provider engine. Unsupported v2-
        // only OAuth methods are intentionally not advertised.
        methods: integration.methods.filter((method) => method.type !== 'oauth') as IntegrationMethod[],
        connections: [...integration.connections],
      })
    }

    for (const provider of providers.all) {
      const current = byID.get(provider.id) ?? {
        id: provider.id,
        name: provider.name,
        methods: [],
        connections: [],
      }
      const legacyMethods = auth[provider.id] ?? []
      const apiMethods = legacyMethods
        .map((method, index) => ({ method, index }))
        .filter(({ method }) => method.type === 'api')
        .map(({ method, index }) => ({
          id: `legacy:${index}`,
          type: 'key' as const,
          label: method.label,
          ...(method.prompts ? { prompts: method.prompts } : {}),
        }))
      const oauthMethods = legacyMethods
        .map((method, index) => ({ method, index }))
        .filter(({ method }) => method.type === 'oauth')
        .map(({ method, index }) => ({
          id: `legacy:${index}`,
          type: 'oauth' as const,
          label: method.label,
          ...(method.prompts ? { prompts: method.prompts } : {}),
        }))
      const existing = apiMethods.length > 0
        ? current.methods.filter((method) => method.type !== 'key')
        : [...current.methods]
      const envNames = vertexEnvironmentNames(provider.id, provider.env)
      if (envNames.length > 0 && !existing.some((method) => method.type === 'env')) {
        existing.push({ type: 'env', names: envNames })
      }
      current.methods = dedupeMethods([...oauthMethods, ...apiMethods, ...existing])
      if (connected.has(provider.id) && !current.connections.some((connection) => connection.id === 'legacy')) {
        current.connections.push({ type: 'provider', id: 'legacy', label: 'Connected through OpenCode' })
      }
      byID.set(provider.id, current)
    }

    return [...byID.values()]
  }

  async connectKey(integrationID: string, key: string, metadata?: Record<string, string>): Promise<void> {
    ensureSuccess(
      (await this.#client.auth.set({
        providerID: integrationID,
        auth: { type: 'api', key, ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}) },
      })) as SdkResult<unknown>,
    )
    // Keep the v2 catalog connection projection in sync when it supports this
    // integration. The stable auth store above is the execution source of truth.
    await this.#client.v2.integration.connect.key({
      integrationID,
      location: { directory: this.#directory },
      key,
    }).catch(() => undefined)
    await this.#reloadProviderState()
  }

  async beginOAuth(integrationID: string, methodID: string, inputs?: Record<string, string>) {
    const method = legacyMethodIndex(methodID)
    const result = unwrap(
      (await this.#client.provider.oauth.authorize({
        providerID: integrationID,
        directory: this.#directory,
        method,
        inputs: inputs ?? {},
      })) as SdkResult<{ url: string; instructions: string; method: 'auto' | 'code' }>,
    )
    const attemptID = randomUUID()
    const attempt: OAuthAttempt = {
      providerID: integrationID,
      method,
      status: 'pending',
      abort: new AbortController(),
    }
    this.#oauthAttempts.set(attemptID, attempt)
    this.#trimOAuthAttempts()
    if (result.method === 'auto') void this.#finishOAuth(attemptID)
    return {
      attemptID,
      url: result.url,
      instructions: result.instructions,
      mode: result.method,
    }
  }

  async completeOAuth(attemptID: string, code: string): Promise<void> {
    const attempt = this.#requireOAuthAttempt(attemptID)
    await this.#finishOAuth(attemptID, code)
    if (attempt.status !== 'complete') throw new Error(attempt.message ?? 'OAuth authorization failed')
  }

  async oauthStatus(attemptID: string): Promise<{ status: string; message?: string }> {
    const attempt = this.#requireOAuthAttempt(attemptID)
    return { status: attempt.status, ...(attempt.message ? { message: attempt.message } : {}) }
  }

  async cancelOAuth(attemptID: string): Promise<void> {
    const attempt = this.#oauthAttempts.get(attemptID)
    if (!attempt || attempt.status !== 'pending') return
    attempt.status = 'cancelled'
    attempt.abort.abort()
  }

  async listSessions(): Promise<SessionInfo[]> {
    const result = unwrap(
      (await this.#client.session.list({
        directory: this.#directory,
        scope: 'project',
        limit: 100,
      })) as SdkResult<LegacySession[]>,
    )
    return result.map((session) => this.#mapSession(session))
  }

  async createSession(model: ModelRef, background = false, graphFirstGate = false, graphOnlySearch = false, graphNativeProfile = false): Promise<SessionInfo> {
    const result = unwrap(
      (await this.#client.session.create({
        directory: this.#directory,
        agent: background ? this.#backgroundAgent : this.#foregroundAgent,
        model: toSessionModel(model),
        permission: background ? backgroundPermissions() : foregroundPermissions(graphFirstGate, graphOnlySearch, graphNativeProfile),
      })) as SdkResult<LegacySession>,
    )
    this.#sessionModels.set(result.id, { ...model })
    if (background) this.#backgroundSessions.add(result.id)
    return this.#mapSession(result)
  }

  async getSession(sessionID: string): Promise<SessionInfo> {
    const result = unwrap(
      (await this.#client.session.get({
        sessionID,
        directory: this.#directory,
      })) as SdkResult<LegacySession>,
    )
    if (!this.#sessionModels.has(sessionID) && result.model) {
      this.#sessionModels.set(sessionID, {
        providerID: result.model.providerID,
        modelID: result.model.id,
        ...(result.model.variant ? { variant: result.model.variant } : {}),
      })
    }
    return this.#mapSession(result)
  }

  async switchModel(sessionID: string, model: ModelRef): Promise<void> {
    // Stable sessions persist the selected model on the next user message.
    // Keeping it here makes /model immediate without restarting the server.
    this.#sessionModels.set(sessionID, { ...model })
  }

  async prompt(
    sessionID: string,
    text: string,
    _delivery: 'queue' | 'steer' = 'queue',
    options: { ephemeralContext?: string } = {},
  ): Promise<void> {
    const model = await this.#modelForSession(sessionID)
    ensureSuccess(
      (await this.#client.session.promptAsync({
        sessionID,
        directory: this.#directory,
        model: { providerID: model.providerID, modelID: model.modelID },
        ...(model.variant ? { variant: model.variant } : {}),
        agent: this.#backgroundSessions.has(sessionID) ? this.#backgroundAgent : this.#foregroundAgent,
        parts: [
          { type: 'text', text },
          ...(options.ephemeralContext
            ? [{ type: 'text' as const, text: options.ephemeralContext, synthetic: true }]
            : []),
        ],
      })) as SdkResult<unknown>,
    )
  }

  async wait(sessionID: string): Promise<void> {
    // prompt_async starts its fiber before returning, but allow a short grace
    // window so an immediate idle observation cannot race session startup. This
    // matters when a second prompt is queued immediately after a completed
    // navigation preflight.
    const started = Date.now()
    const startupGraceMs = 1_000
    let observedBusy = false
    let idleObservations = 0
    while (Date.now() - started < 30 * 60_000) {
      const statuses = unwrap(
        (await this.#client.session.status({ directory: this.#directory })) as SdkResult<
          Record<string, { type: 'idle' | 'busy' | 'retry' }>
        >,
      )
      const status = statuses[sessionID]
      if (status?.type === 'busy' || status?.type === 'retry') {
        observedBusy = true
        idleObservations = 0
      } else {
        idleObservations += 1
        if (observedBusy || (Date.now() - started >= startupGraceMs && idleObservations >= 3)) return
      }
      await delay(50)
    }
    throw new Error(`OpenCode session ${sessionID} did not become idle within 30 minutes`)
  }

  async messages(sessionID: string): Promise<unknown[]> {
    return unwrap(
      (await this.#client.session.messages({
        sessionID,
        directory: this.#directory,
        limit: 200,
      })) as SdkResult<unknown[]>,
    )
  }

  async interrupt(sessionID: string): Promise<void> {
    ensureSuccess(
      (await this.#client.session.abort({ sessionID, directory: this.#directory })) as SdkResult<unknown>,
    )
  }

  async compact(sessionID: string): Promise<void> {
    const model = await this.#modelForSession(sessionID)
    this.emit('event', { type: 'compaction', sessionID, phase: 'started' } satisfies AgentEvent)
    ensureSuccess(
      (await this.#client.session.summarize({
        sessionID,
        directory: this.#directory,
        providerID: model.providerID,
        modelID: model.modelID,
        auto: false,
      })) as SdkResult<unknown>,
    )
  }

  async undo(sessionID: string): Promise<void> {
    const messages = await this.messages(sessionID)
    const user = messages
      .map((item) => record(item).info)
      .map(record)
      .filter((info) => info.role === 'user' && typeof info.id === 'string')
      .sort((left, right) => Number(record(right.time).created ?? 0) - Number(record(left.time).created ?? 0))[0]
    if (!user?.id) throw new Error('No user change boundary is available to undo')
    ensureSuccess(
      (await this.#client.session.revert({
        sessionID,
        directory: this.#directory,
        messageID: String(user.id),
      })) as SdkResult<unknown>,
    )
  }

  async replyPermission(
    _sessionID: string,
    requestID: string,
    reply: 'once' | 'always' | 'reject',
    message?: string,
  ): Promise<void> {
    ensureSuccess(
      (await this.#client.permission.reply({
        requestID,
        directory: this.#directory,
        reply,
        ...(message ? { message } : {}),
      })) as SdkResult<unknown>,
    )
  }

  async denyPendingPermissions(sessionID: string): Promise<number> {
    const pending = unwrap(
      (await this.#client.permission.list({ directory: this.#directory })) as SdkResult<
        Array<{ id: string; sessionID: string }>
      >,
    ).filter((request) => request.sessionID === sessionID)
    for (const request of pending) await this.replyPermission(sessionID, request.id, 'reject')
    return pending.length
  }

  async #consumeEvents(): Promise<void> {
    while (!this.#eventAbort.signal.aborted) {
      try {
        const events = await this.#client.event.subscribe(
          { directory: this.#directory },
          { signal: this.#eventAbort.signal },
        )
        for await (const raw of events.stream) {
          if (this.#eventAbort.signal.aborted) return
          for (const event of this.#normalizer.normalize(raw)) this.emit('event', event)
        }
      } catch (error) {
        if (this.#eventAbort.signal.aborted) return
        this.emit('event', { type: 'error', message: `SSE reconnect: ${message(error)}` } satisfies AgentEvent)
        await delay(500)
      }
    }
  }

  async #finishOAuth(attemptID: string, code?: string): Promise<void> {
    const attempt = this.#requireOAuthAttempt(attemptID)
    if (attempt.status !== 'pending') return
    try {
      ensureSuccess(
        (await this.#client.provider.oauth.callback(
          {
            providerID: attempt.providerID,
            directory: this.#directory,
            method: attempt.method,
            ...(code ? { code } : {}),
          },
          { signal: attempt.abort.signal },
        )) as SdkResult<unknown>,
      )
      if (attempt.abort.signal.aborted) return
      await this.#reloadProviderState()
      attempt.status = 'complete'
    } catch (error) {
      if (attempt.abort.signal.aborted) return
      attempt.status = 'failed'
      attempt.message = message(error)
    }
  }

  #requireOAuthAttempt(attemptID: string): OAuthAttempt {
    const attempt = this.#oauthAttempts.get(attemptID)
    if (!attempt) throw new Error('OAuth attempt is unknown or expired')
    return attempt
  }

  #trimOAuthAttempts(): void {
    while (this.#oauthAttempts.size > 20) {
      const oldest = this.#oauthAttempts.keys().next().value as string | undefined
      if (!oldest) return
      this.#oauthAttempts.get(oldest)?.abort.abort()
      this.#oauthAttempts.delete(oldest)
    }
  }

  async #reloadProviderState(): Promise<void> {
    ensureSuccess((await this.#client.instance.dispose({ directory: this.#directory })) as SdkResult<unknown>)
  }

  async #modelForSession(sessionID: string): Promise<ModelRef> {
    const known = this.#sessionModels.get(sessionID)
    if (known) return known
    const session = await this.getSession(sessionID)
    if (!session.model) throw new Error(`OpenCode session ${sessionID} has no selected model`)
    return session.model
  }

  #mapSession(session: LegacySession): SessionInfo {
    const selected = this.#sessionModels.get(session.id)
    return {
      id: session.id,
      title: session.title,
      ...(session.agent ? { agent: session.agent } : {}),
      ...(selected
        ? { model: { ...selected } }
        : session.model
          ? {
              model: {
                providerID: session.model.providerID,
                modelID: session.model.id,
                ...(session.model.variant ? { variant: session.model.variant } : {}),
              },
            }
          : {}),
      cost: session.cost ?? 0,
      tokens: mapUsage(session.tokens ?? {}),
      updated: session.time.updated,
    }
  }
}

export class OpenCodeEventNormalizer {
  readonly #messageRoles = new Map<string, string>()
  readonly #messageSessions = new Map<string, string>()
  readonly #parts = new Map<string, StreamPart>()
  readonly #toolStates = new Map<string, string>()
  readonly #toolTitles = new Map<string, string>()
  readonly #toolSessions = new Map<string, string>()
  readonly #emittedUsageKeys = new Set<string>()
  readonly #lastEmittedUsage = new Map<string, string>()

  normalize(raw: unknown): AgentEvent[] {
    const wrapper = record(raw)
    const event = record(wrapper.payload ?? raw)
    const type = String(event.type ?? '')
    const data = record(event.data ?? event.properties)
    const err = record(data.error)
    const sessionID = typeof data.sessionID === 'string'
      ? data.sessionID
      : typeof err.sessionID === 'string'
        ? err.sessionID
        : undefined

    switch (type) {
      case 'message.updated':
        return this.#messageUpdated(data)
      case 'message.part.delta':
        return this.#partDelta(data)
      case 'message.part.updated':
        return this.#partUpdated(data)
      case 'message.part.removed':
        if (typeof data.partID === 'string') this.#clearPart(data.partID)
        return []
      case 'session.next.text.delta':
        return sessionID ? [{ type: 'text-delta', sessionID, text: String(data.delta ?? '') }] : []
      case 'session.next.reasoning.delta':
        return sessionID ? [{ type: 'reasoning-delta', sessionID, text: String(data.delta ?? '') }] : []
      case 'session.next.tool.input.started':
        return sessionID
          ? [{
              type: 'tool-start',
              sessionID,
              callID: String(data.callID ?? ''),
              name: String(data.name ?? 'tool'),
              ...(data.input !== undefined ? { input: data.input } : {}),
            }]
          : []
      case 'session.next.tool.called':
        return sessionID
          ? [{
              type: 'tool-start',
              sessionID,
              callID: String(data.callID ?? ''),
              name: String(data.tool ?? data.name ?? 'tool'),
              ...(data.input !== undefined ? { input: data.input } : {}),
            }]
          : []
      case 'session.next.tool.progress': {
        const structured = record(data.structured)
        const content = Array.isArray(data.content) ? data.content : []
        const contentText = content
          .map((item) => record(item).text)
          .find((item): item is string => typeof item === 'string' && item.length > 0)
        return sessionID
          ? [{
              type: 'tool-progress',
              sessionID,
              callID: String(data.callID ?? ''),
              message: String(structured.title ?? structured.message ?? contentText ?? 'working'),
            }]
          : []
      }
      case 'session.next.tool.success':
      case 'session.next.tool.failed':
        if (!sessionID) return []
        return [{
          type: 'tool-end',
          sessionID,
          callID: String(data.callID ?? ''),
          success: type.endsWith('success'),
          ...(typeof data.name === 'string' || typeof data.tool === 'string'
            ? { name: String(data.tool ?? data.name) }
            : {}),
          ...(data.input !== undefined ? { input: data.input } : {}),
          ...(Array.isArray(data.outputPaths) ? { outputPaths: data.outputPaths.map(String) } : {}),
          ...(() => {
            const diff = toolCompletionDiff(data)
            return diff ? { diff } : {}
          })(),
          ...toolCompletionTelemetry(data),
        }]
      case 'session.diff':
        return sessionID && Array.isArray(data.diff) ? [{ type: 'diff', sessionID, diff: data.diff }] : []
      case 'permission.v2.asked':
        return typeof data.id === 'string' && sessionID
          ? [{
              type: 'permission',
              request: {
                id: data.id,
                sessionID,
                action: String(data.action ?? 'unknown'),
                resources: Array.isArray(data.resources) ? data.resources.map(String) : [],
                ...(Array.isArray(data.save) ? { save: data.save.map(String) } : {}),
                ...(recordOrUndefined(data.metadata) ? { metadata: record(data.metadata) } : {}),
              },
            }]
          : []
      case 'permission.asked':
        return typeof data.id === 'string' && sessionID
          ? [{
              type: 'permission',
              request: {
                id: data.id,
                sessionID,
                action: String(data.permission ?? 'unknown'),
                resources: Array.isArray(data.patterns) ? data.patterns.map(String) : [],
                ...(Array.isArray(data.always) ? { save: data.always.map(String) } : {}),
                ...(recordOrUndefined(data.metadata) ? { metadata: record(data.metadata) } : {}),
              },
            }]
          : []
      case 'session.next.step.ended':
      case 'session.step.ended':
      case 'step.ended':
      case 'session.usage': {
        if (!sessionID) return []
        const usage = mapUsage(record(data.tokens ?? data.usage ?? record(data.step).tokens))
        const cost = Number(data.cost ?? 0)
        const keyCandidate = String(data.id ?? data.partID ?? data.stepID ?? record(data.step).id ?? '')
        return this.#emitUsage(sessionID, usage, cost, keyCandidate)
      }
      case 'session.next.compaction.started':
        return sessionID ? [{ type: 'compaction', sessionID, phase: 'started' }] : []
      case 'session.next.compaction.ended':
      case 'session.compacted':
        return sessionID ? [{ type: 'compaction', sessionID, phase: 'ended' }] : []
      case 'session.idle':
        if (sessionID) this.#clearSession(sessionID)
        return sessionID ? [{ type: 'idle', sessionID }] : []
      case 'session.created':
      case 'session.updated': {
        const info = record(data.info ?? data.session)
        const id = sessionID ?? (typeof info.id === 'string' ? info.id : undefined)
        const agent = typeof info.agent === 'string' ? info.agent : undefined
        return id ? [{ type: 'session', sessionID: id, ...(agent ? { agent } : {}) }] : []
      }
      case 'session.error':
        return [{ type: 'error', ...(sessionID ? { sessionID } : {}), message: message(data.error) }]
      default:
        return []
    }
  }

  #messageUpdated(data: Record<string, unknown>): AgentEvent[] {
    const info = record(data.info)
    if (typeof info.id !== 'string' || typeof info.role !== 'string') return []
    this.#messageRoles.set(info.id, info.role)
    if (typeof info.sessionID === 'string') this.#messageSessions.set(info.id, info.sessionID)
    const events: AgentEvent[] = []
    for (const part of this.#parts.values()) {
      if (part.messageID === info.id) events.push(...this.#flushPart(part))
    }
    return events
  }

  #partDelta(data: Record<string, unknown>): AgentEvent[] {
    if (data.field !== 'text' || typeof data.delta !== 'string') return []
    if (typeof data.partID !== 'string' || typeof data.messageID !== 'string' || typeof data.sessionID !== 'string') return []
    const part = this.#parts.get(data.partID) ?? {
      sessionID: data.sessionID,
      messageID: data.messageID,
      text: '',
      emitted: 0,
    }
    part.text += data.delta
    this.#parts.set(data.partID, part)
    this.#messageSessions.set(data.messageID, data.sessionID)
    return this.#flushPart(part)
  }

  #partUpdated(data: Record<string, unknown>): AgentEvent[] {
    const part = record(data.part)
    const sessionID = typeof part.sessionID === 'string' ? part.sessionID : typeof data.sessionID === 'string' ? data.sessionID : undefined
    const partID = typeof part.id === 'string' ? part.id : undefined
    const messageID = typeof part.messageID === 'string' ? part.messageID : undefined
    if (!sessionID || !partID || !messageID) return []
    this.#messageSessions.set(messageID, sessionID)
    if (part.type === 'text' || part.type === 'reasoning') {
      const stream = this.#parts.get(partID) ?? { sessionID, messageID, text: '', emitted: 0 }
      stream.sessionID = sessionID
      stream.messageID = messageID
      stream.kind = part.type
      if (typeof part.text === 'string') stream.text = part.text
      this.#parts.set(partID, stream)
      return this.#flushPart(stream)
    }
    if (part.type === 'tool') return this.#toolUpdated(sessionID, partID, part)
    if (part.type === 'step-finish') {
      const usage = mapUsage(record(part.tokens))
      const cost = Number(part.cost ?? 0)
      const keyCandidate = String(partID ?? part.id ?? '')
      return this.#emitUsage(sessionID, usage, cost, keyCandidate)
    }
    return []
  }

  #flushPart(part: StreamPart): AgentEvent[] {
    const role = this.#messageRoles.get(part.messageID)
    if (!role || !part.kind) return []
    if (role !== 'assistant') {
      part.emitted = part.text.length
      return []
    }
    const delta = part.text.slice(part.emitted)
    part.emitted = part.text.length
    if (!delta) return []
    return [{
      type: part.kind === 'text' ? 'text-delta' : 'reasoning-delta',
      sessionID: part.sessionID,
      text: delta,
    }]
  }

  #toolUpdated(sessionID: string, partID: string, part: Record<string, unknown>): AgentEvent[] {
    const state = record(part.state)
    const status = String(state.status ?? '')
    const previous = this.#toolStates.get(partID)
    const callID = String(part.callID ?? partID)
    const name = String(part.tool ?? 'tool')
    const events: AgentEvent[] = []
    this.#toolSessions.set(partID, sessionID)
    const started = previous === 'running' || previous === 'completed' || previous === 'error'
    if ((status === 'running' || status === 'completed' || status === 'error') && !started) {
      events.push({
        type: 'tool-start',
        sessionID,
        callID,
        name,
        ...(state.input !== undefined ? { input: state.input } : {}),
      })
    }
    const title = typeof state.title === 'string' ? state.title : undefined
    if (status === 'running' && title && title !== this.#toolTitles.get(partID)) {
      events.push({ type: 'tool-progress', sessionID, callID, message: title })
      this.#toolTitles.set(partID, title)
    }
    if ((status === 'completed' || status === 'error') && previous !== 'completed' && previous !== 'error') {
      events.push({
        type: 'tool-end',
        sessionID,
        callID,
        success: status === 'completed',
        name,
        ...(state.input !== undefined ? { input: state.input } : {}),
        ...(() => {
          const outputPaths = extractOutputPaths(part)
          return outputPaths.length > 0 ? { outputPaths } : {}
        })(),
        ...(() => {
          const diff = toolCompletionDiff(state, part)
          return diff ? { diff } : {}
        })(),
        ...toolCompletionTelemetry(state, part),
      })
    }
    this.#toolStates.set(partID, status)
    return events
  }

  #emitUsage(sessionID: string, usage: TokenUsage, cost: number, keyCandidate?: string): AgentEvent[] {
    const usageSig = `${sessionID}:${usage.input}:${usage.output}:${usage.reasoning}:${usage.cacheRead}:${usage.cacheWrite}:${cost}`
    const usageKey = keyCandidate && keyCandidate.length > 0 ? `${sessionID}:${keyCandidate}` : usageSig

    if (this.#emittedUsageKeys.has(usageKey) || this.#lastEmittedUsage.get(sessionID) === usageSig) {
      return []
    }

    this.#emittedUsageKeys.add(usageKey)
    if (this.#emittedUsageKeys.size > 1_000) {
      const oldest = this.#emittedUsageKeys.values().next().value as string | undefined
      if (oldest) this.#emittedUsageKeys.delete(oldest)
    }
    this.#lastEmittedUsage.set(sessionID, usageSig)

    return [{
      type: 'usage',
      sessionID,
      usage,
      cost,
    }]
  }

  #clearSession(sessionID: string): void {
    this.#lastEmittedUsage.delete(sessionID)
    for (const [id, part] of this.#parts) {
      if (part.sessionID === sessionID) this.#parts.delete(id)
    }
    for (const [id, owner] of this.#messageSessions) {
      if (owner !== sessionID) continue
      this.#messageSessions.delete(id)
      this.#messageRoles.delete(id)
    }
    for (const [id, owner] of this.#toolSessions) {
      if (owner !== sessionID) continue
      this.#toolSessions.delete(id)
      this.#toolStates.delete(id)
      this.#toolTitles.delete(id)
    }
  }

  #clearPart(partID: string): void {
    this.#parts.delete(partID)
    this.#toolSessions.delete(partID)
    this.#toolStates.delete(partID)
    this.#toolTitles.delete(partID)
  }
}

function foregroundPermissions(graphFirstGate = false, graphOnlySearch = false, graphNativeProfile = false) {
  const navigationAction = graphFirstGate ? 'ask' : 'allow'
  const searchAction = graphOnlySearch || graphNativeProfile ? 'deny' : navigationAction
  return [
    { permission: '*', pattern: '*', action: 'ask' as const },
    { permission: 'read', pattern: '*', action: navigationAction as 'allow' | 'ask' },
    { permission: 'read', pattern: '*.env', action: 'ask' as const },
    { permission: 'read', pattern: '*.env.*', action: 'ask' as const },
    { permission: 'read', pattern: '**/.env', action: 'ask' as const },
    { permission: 'read', pattern: '**/.env.*', action: 'ask' as const },
    { permission: 'read', pattern: '**/*credentials*', action: 'ask' as const },
    { permission: 'read', pattern: '**/*.pem', action: 'ask' as const },
    { permission: 'read', pattern: '**/*.key', action: 'ask' as const },
    { permission: 'read', pattern: '*.env.example', action: navigationAction as 'allow' | 'ask' },
    { permission: 'read', pattern: '**/.env.example', action: navigationAction as 'allow' | 'ask' },
    { permission: 'read', pattern: '**/.claude.json', action: 'deny' as const },
    { permission: 'read', pattern: '**/.cuppet/credentials.json', action: 'deny' as const },
    { permission: 'read', pattern: '**/.cuppet/ltm-trie.json', action: 'deny' as const },
    { permission: 'glob', pattern: '*', action: searchAction as 'allow' | 'ask' | 'deny' },
    { permission: 'grep', pattern: '*', action: searchAction as 'allow' | 'ask' | 'deny' },
    { permission: 'lsp', pattern: '*', action: searchAction as 'allow' | 'ask' | 'deny' },
    { permission: 'list', pattern: '*', action: graphNativeProfile ? 'deny' as const : navigationAction as 'allow' | 'ask' },
    { permission: 'question', pattern: '*', action: navigationAction as 'allow' | 'ask' },
    { permission: 'todowrite', pattern: '*', action: navigationAction as 'allow' | 'ask' },
    { permission: 'cuppet_plan', pattern: '*', action: 'allow' as const },
    { permission: 'cuppet_memory_search', pattern: '*', action: 'allow' as const },
    { permission: 'cuppet_workspace_info', pattern: '*', action: 'allow' as const },
    { permission: 'cuppet_graph_tree', pattern: '*', action: 'allow' as const },
    { permission: 'cuppet_graph_search', pattern: '*', action: 'allow' as const },
    { permission: 'cuppet_graph_trace', pattern: '*', action: 'allow' as const },
    { permission: 'edit', pattern: '*', action: 'ask' as const },
    { permission: 'edit', pattern: '**/.claude.json', action: 'deny' as const },
    { permission: 'edit', pattern: '**/.cuppet/credentials.json', action: 'deny' as const },
    { permission: 'edit', pattern: '**/.cuppet/ltm-trie.json', action: 'deny' as const },
    { permission: 'bash', pattern: '*', action: 'ask' as const },
    { permission: 'external_directory', pattern: '*', action: 'ask' as const },
    { permission: 'webfetch', pattern: '*', action: graphOnlySearch || graphNativeProfile ? 'deny' as const : 'ask' as const },
    { permission: 'websearch', pattern: '*', action: graphOnlySearch || graphNativeProfile ? 'deny' as const : 'ask' as const },
    { permission: 'task', pattern: '*', action: graphOnlySearch || graphNativeProfile ? 'deny' as const : 'ask' as const },
    { permission: 'skill', pattern: '*', action: graphNativeProfile ? 'deny' as const : 'ask' as const },
  ]
}

function backgroundPermissions() {
  return [{ permission: '*', pattern: '*', action: 'deny' as const }]
}

function enabledModalities(modalities: Record<string, boolean>): string[] {
  return Object.entries(modalities).filter(([, enabled]) => enabled).map(([name]) => name)
}

function vertexEnvironmentNames(providerID: string, names: string[]): string[] {
  if (providerID !== 'google-vertex' && providerID !== 'google-vertex-anthropic') return [...names]
  return [...new Set([
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'GOOGLE_VERTEX_PROJECT',
    'GOOGLE_VERTEX_LOCATION',
    ...names,
  ])]
}

function dedupeMethods(methods: IntegrationMethod[]): IntegrationMethod[] {
  const seen = new Set<string>()
  return methods.filter((method) => {
    const key = method.type === 'env'
      ? `env:${[...method.names].sort().join(',')}`
      : `${method.type}:${method.id ?? ''}:${method.label ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function legacyMethodIndex(methodID: string): number {
  const match = /^legacy:(\d+)$/.exec(methodID)
  if (!match) throw new Error('This OAuth method is not supported by the OpenCode provider engine')
  return Number(match[1])
}

function toSessionModel(model: ModelRef) {
  return {
    id: model.modelID,
    providerID: model.providerID,
    ...(model.variant ? { variant: model.variant } : {}),
  }
}

function modelKey(model: ModelRef): string {
  return `${model.providerID}\u0000${model.modelID}\u0000${model.variant ?? ''}`
}

function mapUsage(tokens: Record<string, unknown>): TokenUsage {
  const cache = record(tokens.cache)
  const input = Number(tokens.input ?? tokens.prompt ?? tokens.input_tokens ?? tokens.prompt_tokens ?? 0)
  const output = Number(tokens.output ?? tokens.completion ?? tokens.output_tokens ?? tokens.completion_tokens ?? 0)
  const reasoning = Number(tokens.reasoning ?? tokens.reasoning_tokens ?? 0)
  const cacheRead = Number(cache.read ?? cache.read_tokens ?? tokens.cache_read_input_tokens ?? 0)
  const cacheWrite = Number(cache.write ?? cache.write_tokens ?? tokens.cache_creation_input_tokens ?? 0)
  return { input, output, reasoning, cacheRead, cacheWrite }
}

type ToolCompletionTelemetry = {
  outputBytes: number
  resultCount: number
  truncated: boolean
  cacheHit: boolean
}

function toolCompletionDiff(...sources: unknown[]): string | undefined {
  for (const source of sources.map(record)) {
    const output = record(source.output)
    const candidates = [
      record(source.metadata).diff,
      record(output.metadata).diff,
      source.diff,
    ]
    const diff = candidates.find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    if (diff) return diff.slice(0, 64 * 1024)
  }
  return undefined
}

/**
 * Normalize completion measurements without forwarding raw tool output into
 * controller events or ordinary telemetry.  Plugin tools provide these values
 * in metadata; built-ins get conservative measurements from their result.
 */
function toolCompletionTelemetry(...sources: unknown[]): ToolCompletionTelemetry {
  const records = sources.map(record)
  const metadata = records.flatMap((source) => {
    const output = record(source.output)
    return [record(source.metadata), record(output.metadata)]
  })
  const metrics = [...metadata, ...records]
  const output = records
    .map((source) => source.output ?? source.result ?? source.content)
    .find((value) => value !== undefined)
  const explicitBytes = metricNumber(metrics, ['outputBytes', 'output_bytes'])
  const explicitCount = metricNumber(metrics, ['resultCount', 'result_count'])
  return {
    outputBytes: explicitBytes ?? outputByteLength(output),
    resultCount: explicitCount ?? inferResultCount(output),
    truncated: metricBoolean(metrics, ['truncated', 'isTruncated']),
    cacheHit: metricBoolean(metrics, ['cacheHit', 'cache_hit']),
  }
}

function metricNumber(records: Record<string, unknown>[], names: string[]): number | undefined {
  for (const source of records) {
    for (const name of names) {
      const value = Number(source[name])
      if (Number.isFinite(value) && value >= 0) return Math.floor(value)
    }
  }
  return undefined
}

function metricBoolean(records: Record<string, unknown>[], names: string[]): boolean {
  for (const source of records) {
    for (const name of names) {
      if (source[name] === true) return true
    }
  }
  return false
}

function outputByteLength(value: unknown): number {
  if (value === undefined || value === null) return 0
  if (typeof value === 'string') return Buffer.byteLength(value)
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '')
  } catch {
    return 0
  }
}

function inferResultCount(value: unknown): number {
  if (Array.isArray(value)) return value.length
  const source = record(value)
  for (const key of ['matches', 'edges', 'paths', 'files', 'nodes', 'results', 'candidates']) {
    if (Array.isArray(source[key])) return source[key].length
  }
  return 0
}

function extractOutputPaths(part: Record<string, unknown>): string[] {
  const found: string[] = []
  const visit = (value: unknown, key = '') => {
    if (typeof value === 'string') {
      if (/(?:path|file|filename|files)$/i.test(key) && value.length > 0 && value.length < 4_096) found.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key)
      return
    }
    if (!value || typeof value !== 'object') return
    for (const [nextKey, item] of Object.entries(value as Record<string, unknown>)) visit(item, nextKey)
  }
  visit(part.state)
  visit(part.metadata)
  return [...new Set(found)].slice(0, 50)
}

function unwrap<T>(result: SdkResult<T>): T {
  if (result.error) throw new Error(message(result.error))
  if (result.data === undefined) throw new Error('OpenCode returned no data')
  return result.data
}

function ensureSuccess(result: SdkResult<unknown>): void {
  if (result.error) throw new Error(message(result.error))
  if (result.response && !result.response.ok) {
    throw new Error(`OpenCode request failed with HTTP ${result.response.status}`)
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  const result = record(value)
  return Object.keys(result).length > 0 ? result : undefined
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  const value = record(error)
  const data = record(value.data)
  return String(data.message ?? value.message ?? value.name ?? 'Unknown OpenCode error')
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
