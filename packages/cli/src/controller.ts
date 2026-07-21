import { EventEmitter } from 'node:events'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { BackgroundWorker, type BackgroundStats } from './background/worker.js'
import { DEFAULT_STEP_LIMIT } from './constants.js'
import type { PreferenceStore } from './config/preferences.js'
import type { OpenCodeGateway } from './opencode/gateway.js'
import type { RuntimeAssets } from './runtime/assets.js'
import type { RuntimePaths } from './runtime/paths.js'
import type {
  AgentEvent,
  IntegrationInfo,
  ModelInfo,
  ModelRef,
  PermissionRequest,
  SessionInfo,
  TokenUsage,
} from './types.js'
import { buildCuppetContext } from './tst/context.js'
import type { TstClient } from './tst/client.js'
import type { TstNotification } from './tst/client.js'

const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })

export type ControllerSnapshot = {
  models: ModelInfo[]
  integrations: IntegrationInfo[]
  primary?: ModelRef
  secondary?: ModelRef
  activeSession?: SessionInfo
  foregroundUsage: TokenUsage
  foregroundCost: number
  background?: BackgroundStats
  running: boolean
  activeTools: number
  degraded: boolean
  stepCount: number
}

export class CuppetController extends EventEmitter {
  readonly #gateway: OpenCodeGateway
  readonly #tst: TstClient | undefined
  readonly #preferences: PreferenceStore
  readonly #paths: RuntimePaths
  readonly #assets: RuntimeAssets
  readonly #interactive: boolean
  #models: ModelInfo[] = []
  #integrations: IntegrationInfo[] = []
  #primary: ModelRef | undefined
  #secondary: ModelRef | undefined
  #session: SessionInfo | undefined
  #usage = emptyUsage()
  #cost = 0
  #running = false
  #tools = new Map<string, string>()
  #background: BackgroundWorker | undefined
  #stepCount = 0
  #lastUserPrompt = ''
  #assistantBuffer = ''
  #deferredSteer: string | undefined
  #recentSymbols: string[] = []
  #activeDiff = ''
  #unsubscribe: (() => void) | undefined
  #unsubscribeTst: (() => void) | undefined

  constructor(options: {
    gateway: OpenCodeGateway
    tst?: TstClient
    preferences: PreferenceStore
    paths: RuntimePaths
    assets: RuntimeAssets
    interactive: boolean
  }) {
    super()
    this.#gateway = options.gateway
    this.#tst = options.tst
    this.#preferences = options.preferences
    this.#paths = options.paths
    this.#assets = options.assets
    this.#interactive = options.interactive
  }

  async initialize(): Promise<void> {
    this.#unsubscribeTst = this.#tst?.onNotification((notification) => {
      this.#handleTstNotification(notification)
    })
    ;[this.#models, this.#integrations] = await Promise.all([
      this.#gateway.listModels(),
      this.#gateway.listIntegrations(),
    ])
    const preferences = this.#preferences.value
    this.#primary = preferences.primary && this.#findModel(preferences.primary) ? preferences.primary : undefined
    this.#secondary = preferences.secondary && this.#findModel(preferences.secondary) ? preferences.secondary : undefined
    if (this.#secondary) this.#createBackground(preferences.backgroundPaused)

    this.#unsubscribe = this.#gateway.onEvent((event) => void this.#handleEvent(event))
    this.#gateway.startEvents()

    const previousSessionID = preferences.lastSessionByProject[this.#paths.projectID]
    if (previousSessionID && this.#primary) {
      try {
        this.#session = await this.#gateway.getSession(previousSessionID)
        await this.#gateway.switchModel(previousSessionID, this.#primary)
        this.#syncUsage(this.#session)
      } catch {
        // A missing/archived session is not fatal; create lazily on the next prompt.
      }
    }
    this.#changed()
  }

  async close(): Promise<void> {
    this.#unsubscribe?.()
    this.#unsubscribeTst?.()
    await this.#gateway.close()
  }

  get snapshot(): ControllerSnapshot {
    return {
      models: [...this.#models],
      integrations: [...this.#integrations],
      ...(this.#primary ? { primary: { ...this.#primary } } : {}),
      ...(this.#secondary ? { secondary: { ...this.#secondary } } : {}),
      ...(this.#session ? { activeSession: { ...this.#session } } : {}),
      foregroundUsage: { ...this.#usage },
      foregroundCost: this.#cost,
      ...(this.#background ? { background: this.#background.stats } : {}),
      running: this.#running,
      activeTools: this.#tools.size,
      degraded: !this.#tst,
      stepCount: this.#stepCount,
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

  async selectModel(role: 'primary' | 'secondary', model: ModelRef): Promise<void> {
    if (!this.#findModel(model)) throw new Error('The selected model is no longer available')
    if (role === 'primary') {
      this.#primary = model
      await this.#preferences.update({ primary: model })
      if (this.#session) await this.#gateway.switchModel(this.#session.id, model)
    } else {
      this.#secondary = model
      await this.#preferences.update({ secondary: model })
      if (this.#background) this.#background.setModel(model)
      else this.#createBackground(this.#preferences.value.backgroundPaused)
    }
    this.#changed()
  }

  async refreshCatalog(): Promise<void> {
    ;[this.#models, this.#integrations] = await Promise.all([
      this.#gateway.listModels(),
      this.#gateway.listIntegrations(),
    ])
    this.#changed()
  }

  recommendedSecondary(): ModelRef | undefined {
    if (!this.#primary) return undefined
    return recommendSecondary(this.#models, this.#primary)
  }

  async submit(prompt: string, delivery: 'queue' | 'steer' = 'queue'): Promise<void> {
    if (!this.#primary) throw new Error('Choose a primary model before starting a session')
    const session = await this.#ensureSession()
    const model = this.#findModel(this.#primary)
    const enriched = await buildCuppetContext(
      this.#tst,
      session.id,
      prompt,
      model?.context ?? 32_000,
      this.#recentSymbols,
      this.#activeDiff,
    ).catch(() => ({ prompt, contextTokens: 0 }))
    this.#lastUserPrompt = prompt
    this.#assistantBuffer = ''
    this.#running = true
    this.#stepCount = 0
    this.#changed()
    try {
      await this.#gateway.prompt(session.id, enriched.prompt, delivery)
    } catch (error) {
      this.#running = false
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
    const session = await this.#requireSession()
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
  }

  async abort(): Promise<void> {
    const session = await this.#requireSession()
    await this.#gateway.interrupt(session.id)
    this.#running = false
    this.#changed()
  }

  async undo(): Promise<void> {
    const session = await this.#requireSession()
    await this.#gateway.undo(session.id)
  }

  async compact(): Promise<void> {
    const session = await this.#requireSession()
    await this.#gateway.compact(session.id)
    if (this.#tst) {
      await this.#tst.call('compact')
      await this.#tst.call('flush')
    }
  }

  async newSession(): Promise<SessionInfo> {
    if (!this.#primary) throw new Error('Choose a primary model first')
    this.#session = await this.#gateway.createSession(this.#primary)
    this.#usage = emptyUsage()
    this.#cost = 0
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
    this.#session = session
    this.#syncUsage(session)
    await this.#preferences.setLastSession(this.#paths.projectID, sessionID)
    this.#changed()
    return session
  }

  async remember(key: string, value: string, scope: 'project' | 'global'): Promise<string> {
    if (!this.#tst) throw new Error('Memory is unavailable in OpenCode-only degraded mode')
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
    if (!this.#tst) throw new Error('Memory is unavailable in OpenCode-only degraded mode')
    const result = await this.#tst.call<{ removed: number }>('memory.forget', {
      session_id: this.#session?.id ?? 'local',
      key,
    })
    return result.removed
  }

  async clearMemory(scope: 'session' | 'project' | 'global'): Promise<number> {
    if (!this.#tst) throw new Error('Memory is unavailable in OpenCode-only degraded mode')
    const result = await this.#tst.call<{ removed: number }>('memory.forget', {
      session_id: this.#session?.id ?? 'local',
      clear_scope: scope,
    })
    return result.removed
  }

  async setBackgroundPaused(paused: boolean): Promise<void> {
    if (!this.#background && !paused && this.#secondary) this.#createBackground(false)
    if (paused) this.#background?.pause()
    else this.#background?.resume()
    await this.#preferences.update({ backgroundPaused: paused })
    this.#changed()
  }

  async replyPermission(request: PermissionRequest, reply: 'once' | 'always' | 'reject'): Promise<void> {
    await this.#gateway.replyPermission(request.sessionID, request.id, reply)
  }

  async denyPendingPermissions(): Promise<number> {
    return this.#session ? this.#gateway.denyPendingPermissions(this.#session.id) : 0
  }

  async status(): Promise<Record<string, unknown>> {
    const tst = this.#tst
      ? await this.#tst.call<Record<string, unknown>>('status').catch((error) => ({ error: (error as Error).message }))
      : { mode: 'degraded', reason: 'TST daemon unavailable' }
    return {
      session: this.#session,
      primary: this.#primary,
      secondary: this.#secondary,
      foreground: { usage: this.#usage, cost: this.#cost, running: this.#running, steps: this.#stepCount },
      background: this.#background?.stats,
      tst,
    }
  }

  async doctor(): Promise<Record<string, unknown>> {
    const providers = this.#integrations.map((integration) => ({
      id: integration.id,
      connected: integration.connections.length > 0,
      methods: integration.methods.map((method) => method.type),
    }))
    const keyProviderIDs = new Set(['openai', 'anthropic', 'google', 'google-vertex', 'azure'])
    const providerSummary = providers.filter(
      (provider) => provider.connected || keyProviderIDs.has(provider.id),
    )
    const storagePermissions = Object.fromEntries(
      await Promise.all(
        [
          ['project', this.#paths.projectStore, constants.R_OK | constants.W_OK],
          ['global', this.#paths.globalStore, constants.R_OK | constants.W_OK],
          ['runtime', this.#paths.runtime, constants.R_OK | constants.W_OK],
          ['socket', this.#paths.tstSocket, constants.R_OK | constants.W_OK],
        ].map(async ([name, path, mode]) => [name, await inspectPath(String(path), Number(mode))]),
      ),
    )
    return {
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      runtimeSource: this.#assets.source,
      runtimeDiagnostics: this.#assets.diagnostics,
      opencode: {
        available: Boolean(this.#assets.opencode),
        models: this.#models.length,
        providerCatalogSize: providers.length,
        providers: providerSummary,
      },
      tst: this.#tst ? await this.#tst.call('status') : { available: false },
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

  #createBackground(paused: boolean): void {
    if (!this.#secondary) return
    this.#background = new BackgroundWorker({
      gateway: this.#gateway,
      ...(this.#tst ? { tst: this.#tst } : {}),
      model: this.#secondary,
      paused,
    })
    this.#background.on('change', () => this.#changed())
    void this.#enqueueGraphSnapshot()
  }

  #handleTstNotification(notification: TstNotification): void {
    if (notification.method === 'indexing.complete' || notification.method === 'graph.changed') {
      this.#background?.enqueue(
        'graph_batch',
        `graph:${this.#paths.projectID}`,
        `Verified native graph update: ${JSON.stringify(notification.params).slice(0, 6_000)}`,
      )
    }
    this.emit('agent-event', {
      type: 'tst-notification',
      method: notification.method,
      params: notification.params,
    } satisfies AgentEvent)
  }

  async #enqueueGraphSnapshot(): Promise<void> {
    if (!this.#tst || !this.#background) return
    const status = await this.#tst.call<Record<string, unknown>>('status').catch(() => undefined)
    const graph = status?.graph
    if (!graph || typeof graph !== 'object') return
    const files = Number((graph as { files?: unknown }).files ?? 0)
    if (files <= 0) return
    this.#background.enqueue(
      'graph_batch',
      `graph:${this.#paths.projectID}`,
      `Verified native graph snapshot: ${JSON.stringify(graph).slice(0, 6_000)}`,
    )
  }

  async #ensureSession(): Promise<SessionInfo> {
    return this.#session ?? this.newSession()
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

  async #handleEvent(event: AgentEvent): Promise<void> {
    const sessionID = 'sessionID' in event
      ? event.sessionID
      : event.type === 'permission'
        ? event.request.sessionID
        : undefined
    if (sessionID && this.#background?.isBackgroundSession(sessionID)) return
    if (this.#session && sessionID && sessionID !== this.#session.id) return

    if (event.type === 'text-delta') this.#assistantBuffer += event.text
    if (event.type === 'error' && event.sessionID) {
      this.#running = false
      this.#tools.clear()
    }
    if (event.type === 'diff') this.#activeDiff = JSON.stringify(event.diff).slice(0, 8_000)
    if (event.type === 'tool-start') this.#tools.set(event.callID, event.name)
    if (event.type === 'tool-end') {
      if (event.outputPaths?.length) {
        this.#recentSymbols = [...event.outputPaths, ...this.#recentSymbols]
          .filter((value, index, values) => values.indexOf(value) === index)
          .slice(0, 20)
      }
      const name = this.#tools.get(event.callID) ?? 'tool'
      this.#tools.delete(event.callID)
      if (event.success && /(?:bash|shell|test|lint|build)/i.test(name)) {
        await this.#background?.recordSuccessfulValidation(event.sessionID, name)
        this.#background?.enqueue('validation', event.sessionID, `Successful validation tool: ${name}`)
      }
      if (this.#deferredSteer && this.#tools.size === 0 && this.#session) {
        const steer = this.#deferredSteer
        this.#deferredSteer = undefined
        await this.#gateway.interrupt(this.#session.id).catch(() => undefined)
        await this.#gateway.prompt(this.#session.id, steer, 'steer')
      }
    }
    if (event.type === 'usage') {
      this.#stepCount += 1
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
    if (event.type === 'permission' && !this.#interactive) {
      await this.#gateway.replyPermission(event.request.sessionID, event.request.id, 'reject')
      return
    }
    if (event.type === 'idle') {
      this.#running = false
      if (this.#session) {
        const current = this.#session
        const refreshed = await this.#gateway.getSession(current.id).catch(() => current)
        this.#session = refreshed
        this.#syncUsage(refreshed)
      }
      if (this.#tst) {
        await this.#tst
          .call('turn.completed', { session_id: event.sessionID })
          .then(() => this.#tst?.call('flush'))
          .catch(() => undefined)
      }
      this.#background?.enqueue(
        'foreground_turn',
        event.sessionID,
        `User request: ${this.#lastUserPrompt}\nActive verified diff: ${this.#activeDiff.slice(0, 4_000)}\nCompleted response summary source: ${this.#assistantBuffer.slice(0, 6_000)}`,
      )
    }
    this.emit('agent-event', event)
    this.#changed()
  }

  #syncUsage(session: SessionInfo): void {
    this.#usage = { ...session.tokens }
    this.#cost = session.cost
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

async function inspectPath(path: string, accessMode: number): Promise<Record<string, unknown>> {
  try {
    await access(path, accessMode)
    const metadata = await stat(path)
    return { available: true, mode: (metadata.mode & 0o777).toString(8).padStart(3, '0') }
  } catch (error) {
    return { available: false, error: (error as Error).message }
  }
}
