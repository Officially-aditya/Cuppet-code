import { EventEmitter } from 'node:events'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import { BackgroundWorker, type BackgroundStats } from './background/worker.js'
import { readOrchestratorState, writeOrchestratorState } from './control/orchestrator-state.js'
import { DEFAULT_STEP_LIMIT } from './constants.js'
import { migrateLegacyPlatform, type PreferenceStore } from './config/preferences.js'
import type { OpenCodeGateway } from './opencode/gateway.js'
import { shouldAutoApproveBash, shouldAutoApproveWorkspacePermission } from './opencode/safe-bash.js'
import type { RuntimeAssets } from './runtime/assets.js'
import type { RuntimePaths } from './runtime/paths.js'
import type { VertexRuntimeStatus } from './opencode/server.js'
import {
  buildProviderCatalog,
  integrationMatchesProvider,
  modelMatchesProvider,
  modelSupportsCodingAgent,
  providerDescriptorFor,
  validateProviderCapabilities,
} from './platforms.js'
import type {
  AgentEvent,
  IntegrationInfo,
  ModelInfo,
  ModelRef,
  PermissionRequest,
  ProviderDescriptor,
  ProviderID,
  SessionInfo,
  TokenUsage,
} from './types.js'
import { totalTokenUsage } from './usage.js'
import type { TstClient } from './tst/client.js'
import type { TstNotification } from './tst/client.js'
import { redact } from './runtime/logger.js'

const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })

type SessionEvidence = {
  tools: Map<string, string>
  recentSymbols: string[]
  activeDiff: string
  assistantBuffer: string
  lastUserPrompt: string
}

export type ControllerSnapshot = {
  models: ModelInfo[]
  integrations: IntegrationInfo[]
  providers: ProviderDescriptor[]
  provider?: ProviderID
  /** @deprecated Use provider. Kept for existing control/plugin clients. */
  platform?: ProviderID
  primary?: ModelRef
  secondary?: ModelRef
  activeSession?: SessionInfo
  foregroundUsage: TokenUsage
  foregroundCost: number
  background?: BackgroundStats
  orchestrator?: { enabled: boolean }
  running: boolean
  planMode: boolean
  autoMode: boolean
  activeTools: number
  degraded: boolean
  stepCount: number
  vertex: VertexRuntimeStatus
}

export class CuppetController extends EventEmitter {
  readonly #gateway: OpenCodeGateway
  readonly #tst: TstClient | undefined
  readonly #preferences: PreferenceStore
  readonly #paths: RuntimePaths
  readonly #assets: RuntimeAssets
  readonly #vertex: VertexRuntimeStatus
  readonly #interactive: boolean
  #tstAvailable: boolean
  #models: ModelInfo[] = []
  #integrations: IntegrationInfo[] = []
  #providers: ProviderDescriptor[] = []
  #provider: ProviderID | undefined
  #primary: ModelRef | undefined
  #secondary: ModelRef | undefined
  #session: SessionInfo | undefined
  #usage = emptyUsage()
  #cost = 0
  #usageBaseline = emptyUsage()
  #costBaseline = 0
  #usageSessionID: string | undefined
  #running = false
  #planMode = false
  #autoApprovalSessionID: string | undefined
  #orchestrator = false
  #tools = new Map<string, string>()
  #background: BackgroundWorker | undefined
  #stepCount = 0
  #lastUserPrompt = ''
  #assistantBuffer = ''
  #deferredSteer: string | undefined
  #recentSymbols: string[] = []
  #activeDiff = ''
  #sessionEvidence = new Map<string, SessionEvidence>()
  #memoryObservationFailures = 0
  #lastMemoryObservationError: string | undefined
  #unsubscribe: (() => void) | undefined
  #unsubscribeTst: (() => void) | undefined
  #unsubscribeTstDisconnect: (() => void) | undefined

  constructor(options: {
    gateway: OpenCodeGateway
    tst?: TstClient
    preferences: PreferenceStore
    paths: RuntimePaths
    assets: RuntimeAssets
    vertex?: VertexRuntimeStatus
    interactive: boolean
  }) {
    super()
    this.#gateway = options.gateway
    this.#tst = options.tst
    this.#preferences = options.preferences
    this.#paths = options.paths
    this.#assets = options.assets
    this.#vertex = options.vertex ?? missingVertexStatus()
    this.#interactive = options.interactive
    this.#tstAvailable = Boolean(options.tst?.connected)
    // Runtime state file wins (it is the plugin's source of truth); env and
    // stored preference only seed it when the file does not exist yet.
    this.#orchestrator = readOrchestratorState(options.paths) ?? process.env.CUPPET_ORCHESTRATOR === '1'
  }

  async initialize(): Promise<void> {
    this.#unsubscribeTst = this.#tst?.onNotification((notification) => {
      this.#handleTstNotification(notification)
    })
    this.#unsubscribeTstDisconnect = this.#tst?.onDisconnect((error) => {
      this.#tstAvailable = false
      this.#background?.pause()
      this.emit('agent-event', {
        type: 'tst-notification',
        method: 'health.degraded',
        params: { message: error.message },
      } satisfies AgentEvent)
      this.#changed()
    })
    await this.#loadCatalog()
    const preferences = this.#preferences.value
    const storedProvider = preferences.provider ?? (preferences.platform ? migrateLegacyPlatform(preferences.platform) : undefined)
    this.#provider = storedProvider ? this.#providerFor(storedProvider)?.id ?? storedProvider : undefined
    if (this.#provider && preferences.provider !== this.#provider) {
      // PreferenceStore performs this migration itself; the optional call also
      // keeps controller integrations that provide legacy preference objects
      // in sync without making test/degraded stores implement persistence.
      await this.#preferences.update?.({ provider: this.#provider })
    }
    const provider = this.#provider ? this.#providerFor(this.#provider) : undefined
    const normalizedPrimary = normalizeLegacyVertexReference(preferences.primary)
    const normalizedSecondary = normalizeLegacyVertexReference(preferences.secondary)
    this.#primary =
      provider &&
        normalizedPrimary &&
        this.#findModel(normalizedPrimary) &&
        modelMatchesProvider(normalizedPrimary, provider) &&
        this.#modelCompatible(normalizedPrimary, 'primary')
        ? normalizedPrimary
        : undefined
    this.#secondary =
      provider &&
        normalizedSecondary &&
        this.#findModel(normalizedSecondary) &&
        modelMatchesProvider(normalizedSecondary, provider) &&
        this.#modelCompatible(normalizedSecondary, 'secondary')
        ? normalizedSecondary
        : undefined
    if (!sameReference(preferences.primary, this.#primary) || !sameReference(preferences.secondary, this.#secondary)) {
      await this.#preferences.update({ primary: this.#primary, secondary: this.#secondary })
    }
    if (this.#secondary) this.#createBackground(preferences.backgroundPaused)

    this.#unsubscribe = this.#gateway.onEvent((event) => void this.#handleEvent(event))
    this.#gateway.startEvents()

    // Session selection belongs to the native TUI or the remote client. Do not
    // turn the persisted last-session pointer into an implicit resume: a fresh
    // launch must remain a fresh session until the user explicitly resumes one.
    this.#changed()
  }

  async close(): Promise<void> {
    this.#unsubscribe?.()
    this.#unsubscribeTst?.()
    this.#unsubscribeTstDisconnect?.()
    await this.#background?.close()
    await this.#gateway.close()
  }

  get snapshot(): ControllerSnapshot {
    return {
      models: [...this.#models],
      integrations: [...this.#integrations],
      providers: this.providerCatalog(),
      ...(this.#provider ? { provider: this.#provider, platform: this.#provider } : {}),
      ...(this.#primary ? { primary: { ...this.#primary } } : {}),
      ...(this.#secondary ? { secondary: { ...this.#secondary } } : {}),
      ...(this.#session ? { activeSession: { ...this.#session } } : {}),
      foregroundUsage: { ...this.#usage },
      foregroundCost: this.#cost,
      ...(this.#background ? { background: this.#background.stats } : {}),
      running: this.#running,
      planMode: this.#planMode,
      autoMode: this.autoApprovalEnabled,
      orchestrator: { enabled: this.#orchestrator },
      activeTools: this.#tools.size,
      degraded: !this.#tstAvailable,
      stepCount: this.#stepCount,
      vertex: structuredClone(this.#vertex),
    }
  }

  onChange(listener: (snapshot: ControllerSnapshot) => void): () => void {
    this.on('change', listener)
    return () => this.off('change', listener)
  }

  onAgentEvent(listener: (event: AgentEvent) => void): () => void {
    this.on('agent-event', listener)
    return () => this.off('agent-event', listener)
  }

  async selectProvider(providerID: ProviderID): Promise<void> {
    const descriptor = this.#providerFor(providerID)
    if (!descriptor) throw new Error(`Provider ${providerID} is not available in OpenCode`)
    validateProviderCapabilities(descriptor)
    const provider = descriptor.id
    this.#provider = provider
    const primaryCandidates = this.modelsForProvider(provider, 'primary')
    const primary = primaryCandidates[0]
      ? { providerID: primaryCandidates[0].providerID, modelID: primaryCandidates[0].modelID }
      : undefined
    const secondaryCandidates = this.modelsForProvider(provider, 'secondary')
    const secondary = secondaryCandidates[0]
      ? { providerID: secondaryCandidates[0].providerID, modelID: secondaryCandidates[0].modelID }
      : undefined
    this.#primary = primary
    this.#secondary = secondary
    this.#background?.pause()
    await this.#preferences.update({ provider, primary, secondary })
    this.#changed()
  }

  /** @deprecated Use selectProvider. */
  async selectPlatform(providerID: ProviderID): Promise<void> {
    return this.selectProvider(providerID)
  }

  providerCatalog(): ProviderDescriptor[] {
    return this.#providers.map((provider) => structuredClone(provider))
  }

  modelsForProvider(
    providerID = this.#provider,
    role: 'primary' | 'secondary' = 'primary',
  ): ModelInfo[] {
    const provider = providerID ? this.#providerFor(providerID) : undefined
    if (!provider) return []
    return this.#models
      .filter((model) => modelMatchesProvider(model, provider) && isModelCompatible(model, role))
      .map((model) => structuredClone(model))
  }

  /** @deprecated Use modelsForProvider. */
  modelsForPlatform(providerID = this.#provider, role: 'primary' | 'secondary' = 'primary'): ModelInfo[] {
    return this.modelsForProvider(providerID, role)
  }

  integrationsForProvider(providerID = this.#provider): IntegrationInfo[] {
    const provider = providerID ? this.#providerFor(providerID) : undefined
    if (!provider) return []
    return this.#integrations
      .filter((integration) => integrationMatchesProvider(integration, provider))
      .map((integration) => structuredClone(integration))
  }

  /** @deprecated Use integrationsForProvider. */
  integrationsForPlatform(providerID = this.#provider): IntegrationInfo[] {
    return this.integrationsForProvider(providerID)
  }

  async selectModel(role: 'primary' | 'secondary', model: ModelRef): Promise<void> {
    const provider = this.#provider ? this.#providerFor(this.#provider) : undefined
    if (!provider) throw new Error('Choose a provider before selecting a model')
    if (!modelMatchesProvider(model, provider)) {
      throw new Error(`The selected model does not belong to the ${provider.label} provider`)
    }
    if (!this.#findModel(model)) throw new Error('The selected model is no longer available')
    if (!this.#modelCompatible(model, role)) {
      throw new Error(
        role === 'primary'
          ? 'The selected model does not support text coding tools'
          : 'The selected secondary model does not support text coding tools required by subagent tasks',
      )
    }
    if (role === 'primary') {
      this.#primary = model
      await this.#preferences.update({ primary: model })
      if (this.#session) await this.#gateway.switchModel(this.#session.id, model)
    } else {
      this.#secondary = model
      await this.#preferences.update({ secondary: model })
      if (this.#background) {
        this.#background.setModel(model)
        if (!this.#preferences.value.backgroundPaused) this.#background.resume()
      }
      else this.#createBackground(this.#preferences.value.backgroundPaused)
    }
    this.#changed()
  }

  effortOptions(role: 'primary' | 'secondary' = 'primary'): string[] {
    const selected = role === 'primary' ? this.#primary : this.#secondary
    if (!selected) throw new Error(`Choose a ${role} model first`)
    return [...new Set(
      this.#models
        .filter(
          (model) =>
            model.providerID === selected.providerID &&
            model.modelID === selected.modelID &&
            model.variant,
        )
        .map((model) => model.variant as string),
    )]
  }

  async selectEffort(role: 'primary' | 'secondary', effort: string): Promise<string> {
    const selected = role === 'primary' ? this.#primary : this.#secondary
    if (!selected) throw new Error(`Choose a ${role} model first`)
    const options = this.effortOptions(role)
    if (options.length === 0) {
      throw new Error(`${selected.providerID}/${selected.modelID} does not advertise configurable effort levels`)
    }
    const variant = options.find((option) => option.toLowerCase() === effort.toLowerCase())
    if (!variant) {
      throw new Error(`Unsupported ${role} effort "${effort}". Available: ${options.join(', ')}`)
    }
    await this.selectModel(role, {
      providerID: selected.providerID,
      modelID: selected.modelID,
      variant,
    })
    return variant
  }

  async refreshCatalog(): Promise<void> {
    await this.#loadCatalog()
    this.#changed()
  }

  recommendedSecondary(): ModelRef | undefined {
    if (!this.#primary) return undefined
    return recommendSecondary(this.modelsForProvider(this.#provider, 'secondary'), this.#primary)
  }

  togglePlanMode(enable?: boolean): boolean {
    this.#planMode = enable ?? !this.#planMode
    this.#changed()
    return this.#planMode
  }

  /** Synchronize the wrapper with the agent actually selected by native TUI. */
  syncNativeAgent(agent: string, sessionID?: string): boolean {
    if (sessionID && this.#session && sessionID !== this.#session.id) return this.#planMode
    const enabled = agent === 'plan'
    const changed = this.#planMode !== enabled || this.#session?.agent !== agent
    this.#planMode = enabled
    if (this.#session && (!sessionID || sessionID === this.#session.id)) {
      this.#session = { ...this.#session, agent }
    }
    if (changed) this.#changed()
    return enabled
  }

  get planMode(): boolean {
    return this.#planMode
  }

  /** Whether the active session opted into guarded workspace auto-approval. */
  get autoApprovalEnabled(): boolean {
    return Boolean(this.#session && this.#autoApprovalSessionID === this.#session.id)
  }

  async setAutoApprovalEnabled(enabled: boolean, sessionID?: string): Promise<{ enabled: boolean; sessionID: string }> {
    if (sessionID && sessionID !== this.#session?.id) await this.adoptSession(sessionID)
    if (!this.#session) throw new Error('No active session for auto mode')
    this.#autoApprovalSessionID = enabled ? this.#session.id : undefined
    this.#changed()
    return { enabled: this.autoApprovalEnabled, sessionID: this.#session.id }
  }

  async submit(prompt: string, delivery: 'queue' | 'steer' = 'queue'): Promise<void> {
    if (!this.#primary) throw new Error('Choose a primary model before starting a session')
    this.#background?.foregroundStarted()
    let session: SessionInfo
    try {
      session = await this.#ensureSession()
    } catch (error) {
      this.#background?.foregroundIdle('unavailable')
      throw error
    }
    // Keep the last completed diff available to this request's retrieval, then
    // start a fresh verified-diff window for the foreground turn.
    this.#activeDiff = ''
    this.#lastUserPrompt = prompt
    this.#assistantBuffer = ''
    this.#running = true
    this.#stepCount = 0
    this.#changed()

    try {
      await this.#gateway.prompt(session.id, prompt, delivery)
    } catch (error) {
      this.#running = false
      this.#background?.foregroundIdle(session.id)
      this.#changed()
      throw error
    }
  }

  async submitAndWait(prompt: string): Promise<string> {
    const completion = new Promise<void>((resolve, reject) => {
      const listener = (event: AgentEvent) => {
        if (event.type === 'idle') {
          cleanup()
          resolve()
        } else if (event.type === 'error' && (!event.sessionID || event.sessionID === this.#session?.id)) {
          cleanup()
          reject(new Error(event.message))
        }
      }
      const cleanup = () => this.off('agent-event', listener)
      this.on('agent-event', listener)
    })
    await this.submit(prompt)
    await completion
    return this.#assistantBuffer
  }

  async steer(instruction: string, interrupt: boolean): Promise<string> {
    this.#background?.foregroundStarted()
    let session: SessionInfo
    try {
      session = await this.#requireSession()
    } catch (error) {
      this.#background?.foregroundIdle('unavailable')
      throw error
    }
    try {
      if (!interrupt) {
        await this.#gateway.prompt(session.id, instruction, 'steer')
        return 'Steer queued for the next safe model boundary.'
      }
      if (this.#tools.size > 0) {
        this.#deferredSteer = instruction
        return 'A tool is running; interruption is deferred until the tool finishes.'
      }
      if (this.#running) await this.#gateway.interrupt(session.id)
      await this.#gateway.prompt(session.id, instruction, 'steer')
      return 'Model request interrupted and steer submitted.'
    } catch (error) {
      this.#background?.foregroundIdle(session.id)
      throw error
    }
  }

  async abort(): Promise<void> {
    const session = await this.#requireSession()
    await this.#gateway.interrupt(session.id)
    this.#running = false
    this.#background?.foregroundIdle(session.id)
    this.#changed()
  }

  async undo(): Promise<void> {
    const session = await this.#requireSession()
    await this.#gateway.undo(session.id)
  }

  async compact(): Promise<void> {
    const session = await this.#requireSession()
    await this.#gateway.compact(session.id)
    if (this.#tstAvailable && this.#tst) {
      await this.#tst.call('compact')
      await this.#tst.call('flush')
    }
  }

  async newSession(): Promise<SessionInfo> {
    if (!this.#primary) throw new Error('Choose a primary model first')
    this.#saveSessionEvidence()
    this.#session = await this.#gateway.createSession(this.#primary)
    this.#loadSessionEvidence(this.#session.id)
    this.#planMode = this.#session.agent === 'plan'
    this.#startUsageWindow(this.#session)
    await this.#preferences.setLastSession(this.#paths.projectID, this.#session.id)
    this.#changed()
    return this.#session
  }

  async listSessions(): Promise<SessionInfo[]> {
    return this.#gateway.listSessions()
  }

  async resume(sessionID: string): Promise<SessionInfo> {
    const session = await this.#gateway.getSession(sessionID)
    if (this.#primary) await this.#gateway.switchModel(sessionID, this.#primary)
    this.#saveSessionEvidence()
    this.#session = session
    this.#loadSessionEvidence(session.id)
    this.#planMode = session.agent === 'plan'
    this.#startUsageWindow(session)
    await this.#preferences.setLastSession(this.#paths.projectID, sessionID)
    this.#changed()
    return session
  }

  /** Adopt a session selected or created by the native OpenCode TUI. */
  async adoptSession(sessionID: string): Promise<SessionInfo> {
    const session = await this.#gateway.getSession(sessionID)
    if (session.agent === 'cuppet-background') return session
    this.#saveSessionEvidence()
    this.#session = session
    this.#loadSessionEvidence(session.id)
    this.#planMode = session.agent === 'plan'
    this.#startUsageWindow(session)
    if (session.model) {
      const model = this.#findModel(session.model)
      const provider = this.#providerForModel(session.model)
      if (provider) this.#provider = provider
      if (model && this.#modelCompatible(session.model, 'primary')) {
        this.#primary = { ...session.model }
        await this.#preferences.update({ provider: this.#provider, primary: this.#primary })
        if (!this.#secondary || !this.#modelCompatible(this.#secondary, 'secondary')) {
          const recommendation = this.recommendedSecondary()
          if (recommendation) {
            this.#secondary = recommendation
            await this.#preferences.update({ secondary: recommendation })
          }
        }
        if (this.#secondary && !this.#background) this.#createBackground(this.#preferences.value.backgroundPaused)
      }
    }
    this.#changed()
    return session
  }

  async remember(key: string, value: string, scope: 'project' | 'global'): Promise<string> {
    if (!this.#tstAvailable || !this.#tst) throw new Error('Memory is unavailable in OpenCode-only degraded mode')
    const sessionID = this.#session?.id ?? 'local'
    const result = await this.#tst.call<{ id: string }>('memory.remember', {
      session_id: sessionID,
      key,
      value,
      kind: 'preference',
      scope,
    })
    return result.id
  }

  async forget(key: string): Promise<number> {
    if (!this.#tstAvailable || !this.#tst) throw new Error('Memory is unavailable in OpenCode-only degraded mode')
    const result = await this.#tst.call<{ removed: number }>('memory.forget', {
      session_id: this.#session?.id ?? 'local',
      key,
    })
    return result.removed
  }

  async clearMemory(scope: 'session' | 'project' | 'global'): Promise<number> {
    if (!this.#tstAvailable || !this.#tst) throw new Error('Memory is unavailable in OpenCode-only degraded mode')
    const result = await this.#tst.call<{ removed: number }>('memory.forget', {
      session_id: this.#session?.id ?? 'local',
      clear_scope: scope,
    })
    return result.removed
  }

  get orchestratorEnabled(): boolean {
    return this.#orchestrator
  }

  async setOrchestratorEnabled(value: boolean): Promise<void> {
    this.#orchestrator = value
    await writeOrchestratorState(this.#paths, value)
    await this.#preferences.update({ orchestratorEnabled: value })
    this.#changed()
  }

  async setBackgroundPaused(paused: boolean): Promise<void> {
    if (!this.#background && !paused && this.#secondary) this.#createBackground(false)
    if (paused) this.#background?.pause()
    else this.#background?.resume()
    await this.#preferences.update({ backgroundPaused: paused })
    this.#changed()
  }

  async listPendingPermissions(): Promise<Array<{ id: string; sessionID: string }>> {
    return this.#gateway.listPendingPermissions()
  }

  async listPendingQuestions(): Promise<Array<Record<string, unknown>>> {
    return this.#gateway.listPendingQuestions()
  }

  async replyQuestion(requestID: string, answers: string[][]): Promise<void> {
    await this.#gateway.replyQuestion(requestID, answers)
    if (this.#session) {
      this.emit('agent-event', {
        type: 'question-resolved',
        sessionID: this.#session.id,
        requestID,
        accepted: true,
      } satisfies AgentEvent)
    }
  }

  async rejectQuestion(requestID: string): Promise<void> {
    await this.#gateway.rejectQuestion(requestID)
    if (this.#session) {
      this.emit('agent-event', {
        type: 'question-resolved',
        sessionID: this.#session.id,
        requestID,
        accepted: false,
      } satisfies AgentEvent)
    }
  }

  async sessionMessages(sessionID: string): Promise<unknown[]> {
    return this.#gateway.messages(sessionID)
  }

  /**
   * The workspace the host process runs in — v1 exposes exactly one, with a
   * friendly display name rather than a raw filesystem path.
   */
  workspaceInfo(): Record<string, unknown> {
    const home = homedir()
    const full = this.#paths.projectRealpath
    const pathDisplay = home !== '/' && (full === home || full.startsWith(`${home}/`))
      ? `~${full.slice(home.length)}`
      : full
    return {
      workspaceId: this.#paths.projectID,
      name: basename(full),
      pathDisplay,
      activeSessionId: this.#session?.id,
    }
  }

  /** Whether a coding provider is configured and usable (BYOK check). */
  providerStatus(): Record<string, unknown> {
    const snapshot = this.snapshot
    const provider = snapshot.provider
    const descriptor = provider ? this.#providerFor(provider) : undefined
    const providers = descriptor
      ? this.#integrations
          .filter((integration) => integrationMatchesProvider(integration, descriptor))
          .map((integration) => ({
            id: integration.id,
            name: integration.name,
            connected: integration.connections.length > 0,
          }))
      : []
    const compatibleModels = provider ? this.modelsForProvider(provider, 'primary') : []
    const configured =
      providers.some((item) => item.connected) || compatibleModels.length > 0 || this.#models.length > 0
    const selectedModel =
      snapshot.primary?.providerID && snapshot.primary?.modelID
        ? `${snapshot.primary.providerID}/${snapshot.primary.modelID}`
        : null
    return {
      configured: configured || Boolean(snapshot.primary),
      // Coding uses the foreground/primary model. The optional secondary
      // model is a Cuppet background-agent concern and must not block BYOK.
      ready: Boolean((configured || this.#models.length > 0) && (snapshot.primary || compatibleModels.length > 0)),
      providers,
      selectedProvider: provider ?? null,
      selectedModel,
    }
  }

  async replyPermission(request: PermissionRequest, reply: 'once' | 'always' | 'reject', message?: string): Promise<void> {
    await this.#gateway.replyPermission(request.sessionID, request.id, reply, message)
    this.emit('agent-event', {
      type: 'permission-resolved',
      sessionID: request.sessionID,
      requestID: request.id,
      reply,
    } satisfies AgentEvent)
  }

  async denyPendingPermissions(): Promise<number> {
    return this.#session ? this.#gateway.denyPendingPermissions(this.#session.id) : 0
  }

  async status(): Promise<Record<string, unknown>> {
    const tst = this.#tstAvailable && this.#tst
      ? await this.#tst.call<Record<string, unknown>>('status').catch((error) => ({ error: (error as Error).message }))
      : { mode: 'degraded', reason: 'TST daemon unavailable' }
    const providerDescriptor = this.#provider ? this.#providerFor(this.#provider) : undefined
    return {
      provider: this.#provider,
      platform: this.#provider,
      providerLabel: providerDescriptor?.label,
      session: this.#session,
      primary: this.#primary ? this.#findModel(this.#primary) ?? this.#primary : undefined,
      secondary: this.#secondary ? this.#findModel(this.#secondary) ?? this.#secondary : undefined,
      foreground: { usage: this.#usage, cost: this.#cost, running: this.#running, steps: this.#stepCount },
      planMode: this.#planMode,
      approval: { auto: this.autoApprovalEnabled },
      orchestrator: { enabled: this.#orchestrator },
      agent: this.#session?.agent,
      background: this.#background?.stats,
      vertex: this.#vertexDiagnostics(),
      tst,
      memoryObservations: {
        failures: this.#memoryObservationFailures,
        lastError: this.#lastMemoryObservationError,
      },
    }
  }

  async doctor(): Promise<Record<string, unknown>> {
    const providers = this.#integrations.map((integration) => ({
      id: integration.id,
      connected: integration.connections.length > 0,
      methods: integration.methods.map((method) => method.type),
    }))
    const providerSummary = providers
    const storagePermissions = Object.fromEntries(
      await Promise.all(
        [
          ['project', this.#paths.projectStore, constants.R_OK | constants.W_OK],
          ['global', this.#paths.globalStore, constants.R_OK | constants.W_OK],
          ['runtime', this.#paths.runtime, constants.R_OK | constants.W_OK],
          ['socket', this.#paths.tstSocket, constants.R_OK | constants.W_OK],
          ['opencode-state', this.#paths.opencode.state, constants.R_OK | constants.W_OK],
        ].map(async ([name, path, mode]) => [name, await inspectPath(String(path), Number(mode))]),
      ),
    )
    return {
      platform: `${process.platform}-${process.arch}`,
      selectedProvider: this.#provider,
      selectedPlatform: this.#provider,
      node: process.version,
      runtimeSource: this.#assets.source,
      runtimeDiagnostics: this.#assets.diagnostics,
      opencode: {
        available: Boolean(this.#assets.opencode),
        models: this.#models.length,
        providerCatalogSize: this.#providers.length,
        providers: providerSummary,
      },
      vertex: this.#vertexDiagnostics(),
      tst: this.#tstAvailable && this.#tst ? await this.#tst.call('status') : { available: false },
      memoryObservations: {
        failures: this.#memoryObservationFailures,
        lastError: this.#lastMemoryObservationError,
      },
      storage: {
        project: this.#paths.projectStore,
        opencode: this.#paths.opencode.data,
        permissions: storagePermissions,
      },
    }
  }

  get gateway(): OpenCodeGateway {
    return this.#gateway
  }

  #vertexDiagnostics(): Record<string, unknown> {
    const integrations = this.integrationsForProvider('vertex')
    return {
      ...structuredClone(this.#vertex),
      providerIDs: integrations.map((integration) => integration.id),
      connected: integrations.some((integration) => integration.connections.length > 0),
      primaryCompatibleModels: this.modelsForProvider('vertex', 'primary').length,
      secondaryCompatibleModels: this.modelsForProvider('vertex', 'secondary').length,
    }
  }

  #createBackground(paused: boolean): void {
    if (!this.#secondary) return
    this.#background = new BackgroundWorker({
      gateway: this.#gateway,
      ...(this.#tstAvailable && this.#tst ? { tst: this.#tst } : {}),
      model: this.#secondary,
      paused,
      projectStore: this.#paths.projectStore,
    })
    this.#background.on('change', () => this.#changed())
  }

  #handleTstNotification(notification: TstNotification): void {
    this.emit('agent-event', {
      type: 'tst-notification',
      method: notification.method,
      params: notification.params,
    } satisfies AgentEvent)
  }

  async #ensureSession(): Promise<SessionInfo> {
    return this.#session ?? this.newSession()
  }

  async #loadCatalog(): Promise<void> {
    const deadline = Date.now() + 5_000
    do {
      ;[this.#models, this.#integrations] = await Promise.all([
        this.#gateway.listModels(),
        this.#gateway.listIntegrations(),
      ])
      this.#providers = buildProviderCatalog(this.#models, this.#integrations)
      if (this.#models.length > 0 || this.#integrations.length > 0) return
      await new Promise((resolve) => setTimeout(resolve, 150))
    } while (Date.now() < deadline)
  }

  async #requireSession(): Promise<SessionInfo> {
    if (!this.#session) throw new Error('No active session')
    return this.#session
  }

  #findModel(reference: ModelRef): ModelInfo | undefined {
    return this.#models.find(
      (model) =>
        model.providerID === reference.providerID &&
        model.modelID === reference.modelID &&
        model.variant === reference.variant,
    )
  }

  #providerFor(providerID: ProviderID): ProviderDescriptor | undefined {
    return providerDescriptorFor(providerID, this.#providers)
  }

  #providerForModel(model: ModelRef): ProviderID | undefined {
    return this.#providers.find((provider) => modelMatchesProvider(model, provider))?.id
  }

  #modelCompatible(reference: ModelRef, role: 'primary' | 'secondary'): boolean {
    const model = this.#findModel(reference)
    return Boolean(model && isModelCompatible(model, role))
  }

  async #handleEvent(event: AgentEvent): Promise<void> {
    const sessionID = 'sessionID' in event
      ? event.sessionID
      : event.type === 'permission'
        ? event.request.sessionID
        : undefined
    if (sessionID && this.#background?.isBackgroundSession(sessionID)) return
    if (sessionID && (!this.#session || sessionID !== this.#session.id)) {
      if (!this.#interactive) return
      await this.adoptSession(sessionID).catch(() => undefined)
      if (!this.#session || this.#session.id !== sessionID) return
    }

    if (event.type === 'session' && event.agent && event.sessionID === this.#session?.id) {
      this.syncNativeAgent(event.agent, event.sessionID)
    }

    if (
      event.type === 'text-delta' ||
      event.type === 'tool-start' ||
      event.type === 'tool-progress' ||
      event.type === 'permission'
    ) {
      if (!this.#running) {
        this.#running = true
      }
      this.#background?.foregroundStarted()
    }

    if (event.type === 'text-delta') this.#assistantBuffer += event.text
    if (event.type === 'error') {
      this.#running = false
      this.#tools.clear()
      if (event.sessionID) this.#background?.foregroundIdle(event.sessionID)
    }
    if (event.type === 'diff') this.#activeDiff = JSON.stringify(event.diff).slice(0, 8_000)
    if (event.type === 'tool-start') {
      if (!this.#tools.has(event.callID)) {
        this.#tools.set(event.callID, event.name)
        this.#stepCount += 1
        if (this.#stepCount >= DEFAULT_STEP_LIMIT) {
          this.emit('agent-event', {
            type: 'step-limit',
            sessionID: event.sessionID,
            steps: this.#stepCount,
          } satisfies AgentEvent)
        }
      } else if (event.name && event.name !== 'tool') {
        this.#tools.set(event.callID, event.name)
      }
    }
    if (event.type === 'tool-end') {
      if (event.outputPaths?.length) {
        this.#recentSymbols = [...event.outputPaths, ...this.#recentSymbols]
          .filter((value, index, values) => values.indexOf(value) === index)
          .slice(0, 20)
      }
      const name = this.#tools.get(event.callID) ?? event.name ?? 'tool'
      this.#tools.delete(event.callID)
      if (event.success) {
        if (this.#tstAvailable && this.#tst && event.sessionID) {
          const pathStr = event.outputPaths?.[0] ?? ''
          void this.#tst.call('memory.observe', {
            session_id: event.sessionID,
            key: `action:${name}:${pathStr.slice(0, 60)}`,
            value: `Executed ${name}${pathStr ? ` on ${pathStr}` : ''}`,
            kind: 'concept_anchor',
            scope: 'session',
            provenance: 'tool',
          }).catch((error) => this.#recordMemoryObservationFailure(error))
        }
        if (isValidationTool(name, event.input)) {
          await this.#background?.recordSuccessfulValidation(event.sessionID, validationReference(name, event.input))
        }
      }
      if (this.#deferredSteer && this.#tools.size === 0 && this.#session) {
        const steer = this.#deferredSteer
        this.#deferredSteer = undefined
        await this.#gateway.interrupt(this.#session.id).catch(() => undefined)
        await this.#gateway.prompt(this.#session.id, steer, 'steer')
      }
    }
    if (event.type === 'usage') {
      if (this.#stepCount === 0) this.#stepCount = 1
      addUsage(this.#usage, event.usage)
      this.#cost += event.cost
      if (this.#stepCount >= DEFAULT_STEP_LIMIT) {
        this.emit('agent-event', {
          type: 'step-limit',
          sessionID: event.sessionID,
          steps: this.#stepCount,
        } satisfies AgentEvent)
      }
    }
    if (event.type === 'permission') {
      if (!this.#interactive) {
        await this.#gateway.replyPermission(event.request.sessionID, event.request.id, 'reject').catch(() => undefined)
        return
      }
      const autoApprove = shouldAutoApproveBash(event.request) || (
        this.#autoApprovalSessionID === event.request.sessionID &&
        await shouldAutoApproveWorkspacePermission(event.request, this.#paths.projectRealpath)
      )
      if (autoApprove) {
        try {
          // Do not save an OpenCode permission pattern: each command must pass
          // the strict classifier again before it receives an automatic reply.
          await this.#gateway.replyPermission(event.request.sessionID, event.request.id, 'once')
          this.#changed()
          return
        } catch {
          // If OpenCode cannot accept the automatic reply, preserve the normal
          // permission prompt instead of leaving the request hidden and stuck.
        }
      }
    }
    if (event.type === 'idle') {
      this.#running = false
      if (this.#session) {
        const current = this.#session
        const refreshed = await this.#gateway.getSession(current.id).catch(() => current)
        this.#session = refreshed
        this.#syncUsage(refreshed)
      }
      if (this.#tstAvailable && this.#tst) {
        const observation = await this.#gateway.messages(event.sessionID)
          .then(latestTurnObservation)
          .catch(() => undefined)
        if (observation) {
          await this.#tst.call('memory.observe', {
            session_id: event.sessionID,
            key: observation.key,
            value: observation.value,
            kind: 'concept_anchor',
            scope: 'session',
            provenance: 'model_candidate',
          }).catch((error) => this.#recordMemoryObservationFailure(error))
          await this.#background?.recordTurnContext(event.sessionID, observation.value)
        }
        await this.#tst
          .call('turn.completed', { session_id: event.sessionID })
          .then(() => this.#tst?.call('flush'))
          .catch(() => undefined)
      }
      if (this.#activeDiff) await this.#background?.recordVerifiedDiff(event.sessionID, this.#activeDiff)
      this.#background?.foregroundIdle(event.sessionID)
    }
    this.emit('agent-event', event)
    if (event.type !== 'text-delta' && event.type !== 'reasoning-delta') {
      this.#changed()
    }
  }

  #startUsageWindow(session: SessionInfo): void {
    this.#usage = emptyUsage()
    this.#cost = 0
    this.#usageBaseline = { ...session.tokens }
    this.#costBaseline = session.cost
    this.#usageSessionID = session.id
  }

  #recordMemoryObservationFailure(error: unknown): void {
    this.#memoryObservationFailures += 1
    this.#lastMemoryObservationError = redact(error instanceof Error ? error.message : String(error)).slice(0, 300)
    this.#changed()
  }

  #saveSessionEvidence(): void {
    if (!this.#session) return
    this.#sessionEvidence.set(this.#session.id, {
      tools: new Map(this.#tools),
      recentSymbols: [...this.#recentSymbols],
      activeDiff: this.#activeDiff,
      assistantBuffer: this.#assistantBuffer,
      lastUserPrompt: this.#lastUserPrompt,
    })
  }

  #loadSessionEvidence(sessionID: string): void {
    const evidence = this.#sessionEvidence.get(sessionID)
    this.#tools = evidence ? new Map(evidence.tools) : new Map()
    this.#recentSymbols = evidence ? [...evidence.recentSymbols] : []
    this.#activeDiff = evidence?.activeDiff ?? ''
    this.#assistantBuffer = evidence?.assistantBuffer ?? ''
    this.#lastUserPrompt = evidence?.lastUserPrompt ?? ''
  }

  #syncUsage(session: SessionInfo): void {
    if (session.id !== this.#usageSessionID) return
    const usage = usageSince(session.tokens, this.#usageBaseline)
    const sessionTotal = totalTokenUsage(usage)
    const currentTotal = totalTokenUsage(this.#usage)
    if (sessionTotal >= currentTotal && sessionTotal > 0) {
      this.#usage = usage
      this.#cost = Math.max(0, session.cost - this.#costBaseline)
    }
  }

  #changed(): void {
    this.emit('change', this.snapshot)
  }
}

function recommendSecondary(models: ModelInfo[], primary: ModelRef): ModelRef | undefined {
  const candidates = models.filter((model) => model.enabled)
  candidates.sort((left, right) => {
    const leftCost = left.inputCost + left.outputCost
    const rightCost = right.inputCost + right.outputCost
    return leftCost - rightCost || right.context - left.context || left.name.localeCompare(right.name)
  })
  const choice = candidates[0] ?? models.find(
    (model) =>
      model.providerID === primary.providerID &&
      model.modelID === primary.modelID &&
      model.variant === primary.variant,
  )
  return choice
    ? { providerID: choice.providerID, modelID: choice.modelID, ...(choice.variant ? { variant: choice.variant } : {}) }
    : undefined
}

function addUsage(target: TokenUsage, value: TokenUsage): void {
  target.input += value.input
  target.output += value.output
  target.reasoning += value.reasoning
  target.cacheRead += value.cacheRead
  target.cacheWrite += value.cacheWrite
}

function usageSince(total: TokenUsage, baseline: TokenUsage): TokenUsage {
  return {
    input: Math.max(0, total.input - baseline.input),
    output: Math.max(0, total.output - baseline.output),
    reasoning: Math.max(0, total.reasoning - baseline.reasoning),
    cacheRead: Math.max(0, total.cacheRead - baseline.cacheRead),
    cacheWrite: Math.max(0, total.cacheWrite - baseline.cacheWrite),
  }
}

function isValidationTool(name: string, input: unknown): boolean {
  if (/(?:test|lint|build|typecheck|validate|verify|check)/i.test(name)) return true
  if (!/(?:bash|shell|command)/i.test(name)) return false
  let text = typeof input === 'string' ? input : ''
  if (!text && input && typeof input === 'object') {
    try {
      text = JSON.stringify(input)
    } catch {
      return false
    }
  }
  return /(?:\bnpm\s+(?:run\s+)?(?:test|lint|build|typecheck|check)\b|\b(?:cargo|pnpm|yarn)\s+(?:test|check|build|lint)\b|\b(?:pytest|jest|vitest|tsc)\b)/i.test(text)
}

function validationReference(name: string, input: unknown): string {
  if (typeof input === 'string') return `${name}: ${input}`
  if (!input || typeof input !== 'object' || Array.isArray(input)) return name
  const value = input as Record<string, unknown>
  for (const key of ['command', 'cmd', 'script']) {
    if (typeof value[key] === 'string') return `${name}: ${value[key]}`
  }
  return name
}

function latestTurnObservation(messages: unknown[]): { key: string; value: string } | undefined {
  const normalized = messages.map((item) => item && typeof item === 'object' ? item as Record<string, unknown> : {})
  let userIndex = -1
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const info = recordValue(normalized[index]?.info)
    if (info.role === 'user') {
      userIndex = index
      break
    }
  }
  if (userIndex < 0) return undefined
  const user = normalized[userIndex]!
  const userInfo = recordValue(user.info)
  const request = messagePartText(user)
  const outcome = normalized
    .slice(userIndex + 1)
    .filter((message) => recordValue(message.info).role === 'assistant')
    .map(messagePartText)
    .filter(Boolean)
    .join(' ')
  const value = redact([
    request ? `Requirement: ${request}` : '',
    outcome ? `Outcome: ${outcome}` : '',
  ].filter(Boolean).join('\n')).replace(/\s+/g, ' ').trim().slice(0, 1_600)
  if (!value) return undefined
  const messageID = typeof userInfo.id === 'string' ? userInfo.id : String(userIndex)
  return { key: `turn:${messageID}`.slice(0, 120), value }
}

function messagePartText(message: Record<string, unknown>): string {
  if (!Array.isArray(message.parts)) return ''
  return message.parts.flatMap((part) => {
    const value = recordValue(part)
    return value.type === 'text' && typeof value.text === 'string' && value.synthetic !== true
      ? [value.text]
      : []
  }).join(' ')
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

async function inspectPath(path: string, accessMode: number): Promise<Record<string, unknown>> {
  try {
    await access(path, accessMode)
    const metadata = await stat(path)
    return { available: true, mode: (metadata.mode & 0o777).toString(8).padStart(3, '0') }
  } catch (error) {
    return { available: false, error: (error as Error).message }
  }
}

function isModelCompatible(model: ModelInfo, _role: 'primary' | 'secondary'): boolean {
  // Secondary models power native Task subagents as well as background
  // canonicalization, so both roles must support tool calls and streaming.
  return modelSupportsCodingAgent(model)
}

function normalizeLegacyVertexReference(reference: ModelRef | undefined): ModelRef | undefined {
  if (!reference || reference.providerID !== 'vertex') return reference
  return { ...reference, providerID: 'google-vertex' }
}

function sameReference(left: ModelRef | undefined, right: ModelRef | undefined): boolean {
  return left?.providerID === right?.providerID &&
    left?.modelID === right?.modelID &&
    left?.variant === right?.variant
}

function missingVertexStatus(): VertexRuntimeStatus {
  return {
    adc: { available: false, source: 'none', explicitUnavailable: false },
    project: { configured: false, source: 'provider-adc' },
    location: { value: 'global', source: 'cuppet-default' },
  }
}
