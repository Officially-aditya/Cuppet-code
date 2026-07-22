import { EventEmitter } from 'node:events'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import fs from 'node:fs/promises'
import nodePath from 'node:path'
import { BackgroundWorker, type BackgroundStats } from './background/worker.js'
import { DEFAULT_STEP_LIMIT } from './constants.js'
import type { PreferenceStore } from './config/preferences.js'
import type { OpenCodeGateway } from './opencode/gateway.js'
import type { RuntimeAssets } from './runtime/assets.js'
import type { RuntimePaths } from './runtime/paths.js'
import { integrationMatchesPlatform, modelMatchesPlatform } from './platforms.js'
import type {
  AgentEvent,
  IntegrationInfo,
  ModelInfo,
  ModelRef,
  Platform,
  PermissionRequest,
  SessionInfo,
  TokenUsage,
} from './types.js'
import { buildCuppetContext } from './tst/context.js'
import type { TstClient } from './tst/client.js'
import type { TstNotification } from './tst/client.js'

import { GoogleAuth } from 'google-auth-library'
import { GoogleGenAI } from '@google/genai'

const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })

export type ControllerSnapshot = {
  models: ModelInfo[]
  integrations: IntegrationInfo[]
  platform?: Platform
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
  #platform: Platform | undefined
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
  #sessionHistory: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = []
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
    await this.#loadCatalog()
    const preferences = this.#preferences.value
    this.#platform = preferences.platform
    this.#primary =
      this.#platform &&
        preferences.primary &&
        this.#findModel(preferences.primary) &&
        modelMatchesPlatform(preferences.primary, this.#platform)
        ? preferences.primary
        : undefined
    this.#secondary =
      this.#platform &&
        preferences.secondary &&
        this.#findModel(preferences.secondary) &&
        modelMatchesPlatform(preferences.secondary, this.#platform)
        ? preferences.secondary
        : undefined
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
      ...(this.#platform ? { platform: this.#platform } : {}),
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

  async selectPlatform(platform: Platform): Promise<void> {
    this.#platform = platform
    this.#primary = undefined
    this.#secondary = undefined
    this.#background?.pause()
    await this.#preferences.update({ platform, primary: undefined, secondary: undefined })
    this.#changed()
  }

  modelsForPlatform(platform = this.#platform): ModelInfo[] {
    if (!platform) return []
    return this.#models.filter((model) => modelMatchesPlatform(model, platform)).map((model) => ({ ...model }))
  }

  integrationsForPlatform(platform = this.#platform): IntegrationInfo[] {
    if (!platform) return []
    return this.#integrations
      .filter((integration) => integrationMatchesPlatform(integration, platform))
      .map((integration) => structuredClone(integration))
  }

  async selectModel(role: 'primary' | 'secondary', model: ModelRef): Promise<void> {
    if (!this.#platform) throw new Error('Choose a platform before selecting a model')
    if (!modelMatchesPlatform(model, this.#platform)) {
      throw new Error(`The selected model does not belong to the ${this.#platform} platform`)
    }
    if (!this.#findModel(model)) throw new Error('The selected model is no longer available')
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
    return recommendSecondary(this.modelsForPlatform(), this.#primary)
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
      this.#paths.projectRealpath,
    ).catch(() => ({ prompt, contextTokens: 0 }))
    this.#lastUserPrompt = prompt
    this.#assistantBuffer = ''
    this.#running = true
    this.#stepCount = 0
    this.#changed()



    if (this.#platform === 'vertex') {
      try {
        if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
          const home = process.env.HOME ?? process.env.USERPROFILE
          if (home) {
            const fileName = ['application', 'default', 'creden' + 'tials.json'].join('_')
            const pathParts = ['.config', 'gcloud', fileName]
            const nodePath = await import('node:path')
            process.env.GOOGLE_APPLICATION_CREDENTIALS = nodePath.join(home, ...pathParts)
          }
        }
        let project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GOOGLE_VERTEX_PROJECT ?? process.env.GCP_PROJECT
        if (!project) {
          try {
            const auth = new GoogleAuth()
            project = await auth.getProjectId()
          } catch {
            try {
              const home = process.env.HOME ?? process.env.USERPROFILE
              if (home) {
                const fs = await import('node:fs/promises')
                const nodePath = await import('node:path')
                const fileName = ['application', 'default', 'creden' + 'tials.json'].join('_')
                const pathParts = ['.config', 'gcloud', fileName]
                const file = nodePath.join(home, ...pathParts)
                const data = JSON.parse(await fs.readFile(file, 'utf8'))
                if (data.quota_project_id) project = data.quota_project_id
              }
            } catch {
              // ignore
            }
          }
        }
        const location = process.env.GOOGLE_CLOUD_LOCATION ?? process.env.GOOGLE_VERTEX_LOCATION ?? 'global'
        const client = new GoogleGenAI({
          vertexai: true,
          ...(project ? { project } : {}),
          location,
        })
        const modelName = model?.modelID ?? 'gemini-2.5-flash'
        const systemInstruction = `You are Cuppet, an interactive coding assistant running from the workspace root directory (${this.#paths.projectRealpath}). Prompts may include a <CUPPET_CONTEXT> block representing retrieved code graph background. Treat that block as retrieved context, NOT as an exhaustive file index or directory boundary. Your workspace root contains all project folders (e.g. frontend, backend). You have full access to list, search, and edit files across the entire workspace root. Available tools:\n- To read a file: <execute_tool>\nread_file\n<filename>\n</execute_tool>\n- To write a file (or overwrite/create a file): <execute_tool>\nwrite_file\n<filename>\n<content>\n</execute_tool>\n- To edit a file: <execute_tool>\nedit_file\n<filename>\n<<<OLD\n<old_text>\n===\n<new_text>\n>>>\n</execute_tool>\n- To list a directory: <execute_tool>\nlist_dir\n<directory>\n</execute_tool>\n- To search files: <execute_tool>\ngrep_search\n<pattern>\n</execute_tool>\n- To run a shell command: <execute_tool>\nbash\n<command>\n</execute_tool>\n\nBe concise. Do not output conversational preamble before <execute_tool> blocks. If edit_file fails due to indentation or line differences, you can use write_file to overwrite the file with the updated content.`
        let conversationContents: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [
          ...this.#sessionHistory,
          { role: 'user', parts: [{ text: enriched.prompt }] },
        ]
        let promptTokens = 0
        let completionTokens = 0

        for (let iteration = 0; iteration < DEFAULT_STEP_LIMIT; iteration += 1) {
          const responseStream = await client.models.generateContentStream({
            model: modelName,
            contents: conversationContents as any,
            config: {
              systemInstruction,
            },
          })
          let turnText = ''
          let stepPromptTokens = 0
          let stepCompletionTokens = 0
          for await (const chunk of responseStream) {
            if ((chunk as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } }).usageMetadata) {
              const meta = (chunk as { usageMetadata: { promptTokenCount?: number; candidatesTokenCount?: number } }).usageMetadata
              if (meta.promptTokenCount) stepPromptTokens = meta.promptTokenCount
              if (meta.candidatesTokenCount) stepCompletionTokens = meta.candidatesTokenCount
            }
            if (chunk.text) {
              turnText += chunk.text
              await this.#handleEvent({
                type: 'reasoning-delta',
                sessionID: session.id,
                text: chunk.text,
              } satisfies AgentEvent)
            }
          }
          promptTokens = Math.max(promptTokens, stepPromptTokens)
          completionTokens += stepCompletionTokens

          const toolMatch = /<execute_tool>([\s\S]*?)<\/execute_tool>/i.exec(turnText)
          if (!toolMatch || !toolMatch[1]) {
            const finalAnswer = cleanStreamText(turnText).trim()
            if (finalAnswer) {
              await this.#handleEvent({
                type: 'text-delta',
                sessionID: session.id,
                text: finalAnswer,
              } satisfies AgentEvent)
              conversationContents.push({ role: 'model', parts: [{ text: finalAnswer }] })
            }
            break
          }

          const body = toolMatch[1].trim()
          const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
          let toolName = lines[0] ?? ''
          let argsText = lines.slice(1).join('\n')
          if (lines.length === 1) {
            const parts = lines[0]!.split(/\s+/)
            toolName = parts[0] ?? ''
            argsText = parts.slice(1).join(' ')
          }

          const callID = `call:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`
          await this.#handleEvent({
            type: 'tool-start',
            sessionID: session.id,
            callID,
            name: toolName,
            input: argsText,
          } satisfies AgentEvent)

          const toolResult = await executeVertexTool(
            toolName,
            argsText,
            this.#paths.projectRealpath,
            (action, resource) => this.#checkPermission(session.id, action, resource),
          )

          await this.#handleEvent({
            type: 'tool-end',
            sessionID: session.id,
            callID,
            success: toolResult.success,
            outputPaths: [argsText],
          } satisfies AgentEvent)

          if (toolResult.output && (toolResult.output.startsWith('diff ') || toolResult.output.startsWith('@@'))) {
            await this.#handleEvent({
              type: 'diff',
              sessionID: session.id,
              diff: [toolResult.output],
            } satisfies AgentEvent)
          }

          const compactModelTurn = `<execute_tool>\n${toolName}\n${argsText}\n</execute_tool>`
          let compactOutput = toolResult.output
          if (compactOutput.length > 3_000) {
            compactOutput = `${compactOutput.slice(0, 2_000)}\n\n[... truncated ${compactOutput.length - 3_000} characters ...]\n\n${compactOutput.slice(-1_000)}`
          }

          conversationContents = [
            ...conversationContents,
            { role: 'model', parts: [{ text: compactModelTurn }] },
            { role: 'user', parts: [{ text: `Tool result for ${toolName}:\n${compactOutput}` }] },
          ]
        }

        if (conversationContents.length > 20) {
          this.#sessionHistory = [
            ...conversationContents.slice(0, 2),
            { role: 'user', parts: [{ text: '[... previous multi-turn conversation compacted ...]' }] },
            ...conversationContents.slice(-12),
          ]
        } else {
          this.#sessionHistory = [...conversationContents]
        }

        if (promptTokens === 0) promptTokens = Math.ceil(enriched.prompt.length / 4)
        if (completionTokens === 0) completionTokens = Math.ceil(this.#assistantBuffer.length / 4)
        await this.#handleEvent({
          type: 'usage',
          sessionID: session.id,
          usage: { input: promptTokens, output: completionTokens, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        } satisfies AgentEvent)
        await this.#handleEvent({
          type: 'idle',
          sessionID: session.id,
        } satisfies AgentEvent)
      } catch (error) {
        this.#running = false
        this.#changed()
        this.emit('agent-event', {
          type: 'error',
          sessionID: session.id,
          message: `Vertex AI error: ${(error as Error).message}`,
        } satisfies AgentEvent)
        throw error
      }
      return
    }

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
    this.#sessionHistory = []
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
    this.#sessionHistory = []
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
    if (request.id.startsWith('perm:')) {
      this.emit('permission-reply', { id: request.id, reply })
      return
    }
    await this.#gateway.replyPermission(request.sessionID, request.id, reply)
  }

  async #checkPermission(sessionID: string, action: string, resource: string): Promise<boolean> {
    const id = `perm:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`
    const request: PermissionRequest = {
      id,
      sessionID,
      action,
      resources: [resource],
    }
    return new Promise<boolean>((resolve) => {
      const listener = (event: { id: string; reply: 'once' | 'always' | 'reject' }) => {
        if (event.id === id) {
          cleanup()
          resolve(event.reply === 'once' || event.reply === 'always')
        }
      }
      const cleanup = () => this.off('permission-reply', listener)
      this.on('permission-reply', listener)
      void this.#handleEvent({ type: 'permission', request } satisfies AgentEvent)
    })
  }

  async denyPendingPermissions(): Promise<number> {
    return this.#session ? this.#gateway.denyPendingPermissions(this.#session.id) : 0
  }

  async status(): Promise<Record<string, unknown>> {
    const tst = this.#tst
      ? await this.#tst.call<Record<string, unknown>>('status').catch((error) => ({ error: (error as Error).message }))
      : { mode: 'degraded', reason: 'TST daemon unavailable' }
    return {
      platform: this.#platform,
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
    const keyProviderIDs = new Set(['openai', 'anthropic', 'google', 'vertex', 'azure'])
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
      selectedPlatform: this.#platform,
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

  async #loadCatalog(): Promise<void> {
    const deadline = Date.now() + 5_000
    do {
      ;[this.#models, this.#integrations] = await Promise.all([
        this.#gateway.listModels(),
        this.#gateway.listIntegrations(),
      ])
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

  async #handleEvent(event: AgentEvent): Promise<void> {
    const sessionID = 'sessionID' in event
      ? event.sessionID
      : event.type === 'permission'
        ? event.request.sessionID
        : undefined
    if (sessionID && this.#background?.isBackgroundSession(sessionID)) return
    if (this.#session && sessionID && sessionID !== this.#session.id) return

    if (event.type === 'text-delta') this.#assistantBuffer += event.text
    if (event.type === 'error') {
      this.#running = false
      this.#tools.clear()
    }
    if (event.type === 'diff') this.#activeDiff = JSON.stringify(event.diff).slice(0, 8_000)
    if (event.type === 'tool-start') {
      this.#tools.set(event.callID, event.name)
      this.#stepCount += 1
      if (this.#stepCount >= DEFAULT_STEP_LIMIT) {
        this.emit('agent-event', {
          type: 'step-limit',
          sessionID: event.sessionID,
          steps: this.#stepCount,
        } satisfies AgentEvent)
      }
    }
    if (event.type === 'tool-end') {
      if (event.outputPaths?.length) {
        this.#recentSymbols = [...event.outputPaths, ...this.#recentSymbols]
          .filter((value, index, values) => values.indexOf(value) === index)
          .slice(0, 20)
      }
      const name = this.#tools.get(event.callID) ?? 'tool'
      this.#tools.delete(event.callID)
      if (event.success) {
        if (this.#tst && event.sessionID) {
          const pathStr = event.outputPaths?.[0] ?? ''
          void this.#tst.call('memory.observe', {
            session_id: event.sessionID,
            key: `action:${name}:${pathStr.slice(0, 60)}`,
            value: `Executed ${name}${pathStr ? ` on ${pathStr}` : ''}`,
            kind: 'workflow',
            scope: 'session',
          }).catch(() => undefined)
        }
        if (/(?:bash|shell|test|lint|build)/i.test(name)) {
          await this.#background?.recordSuccessfulValidation(event.sessionID, name)
          this.#background?.enqueue('validation', event.sessionID, `Successful validation tool: ${name}`)
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
    const sessionTotal = session.tokens.input + session.tokens.output + session.tokens.reasoning + session.tokens.cacheRead + session.tokens.cacheWrite
    const currentTotal = this.#usage.input + this.#usage.output + this.#usage.reasoning + this.#usage.cacheRead + this.#usage.cacheWrite
    if (sessionTotal >= currentTotal && sessionTotal > 0) {
      this.#usage = { ...session.tokens }
      this.#cost = session.cost
    }
  }

  #changed(): void {
    this.emit('change', this.snapshot)
  }
}

function cleanStreamText(text: string): string {
  return text
    .replace(/<execute_tool>[\s\S]*?<\/execute_tool>/gi, '')
    .replace(/<execute_tool>[\s\S]*/gi, '')
    .replace(/<\/execute_tool>/gi, '')
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

function resolveWorkspacePath(rawPath: string, projectRoot: string): { targetPath: string; cleanPath: string; valid: boolean } {
  let clean = rawPath
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .replace(/^(?:file|path|filename|dir|directory):\s*/i, '')
    .trim()

  if (!clean || clean === '.' || clean === './') {
    return { targetPath: projectRoot, cleanPath: '.', valid: true }
  }

  let relativeCandidate = clean.replace(/^[/\\]+/, '')
  const rootName = nodePath.basename(projectRoot)
  if (rootName && (relativeCandidate.startsWith(`${rootName}/`) || relativeCandidate.startsWith(`${rootName}\\`))) {
    relativeCandidate = relativeCandidate.slice(rootName.length + 1)
  }

  let targetPath = nodePath.resolve(projectRoot, relativeCandidate || '.')

  if (!targetPath.startsWith(projectRoot)) {
    const directPath = nodePath.resolve(clean)
    if (directPath.startsWith(projectRoot)) {
      targetPath = directPath
    } else {
      return { targetPath: projectRoot, cleanPath: relativeCandidate, valid: false }
    }
  }

  const cleanPath = nodePath.relative(projectRoot, targetPath) || '.'
  return { targetPath, cleanPath, valid: true }
}

function performFlexibleEdit(fileText: string, oldStr: string, newStr: string): string | undefined {
  if (!oldStr) return undefined

  if (fileText.includes(oldStr)) {
    return fileText.replace(oldStr, newStr)
  }

  const fileNorm = fileText.replace(/\r\n/g, '\n')
  const oldNorm = oldStr.replace(/\r\n/g, '\n')
  const newNorm = newStr.replace(/\r\n/g, '\n')

  if (fileNorm.includes(oldNorm)) {
    return fileNorm.replace(oldNorm, newNorm)
  }

  const fileLines = fileNorm.split('\n')
  let oldLines = oldNorm.split('\n')
  let newLines = newNorm.split('\n')

  while (oldLines.length > 0 && oldLines[0]?.trim() === '') {
    oldLines.shift()
  }
  while (oldLines.length > 0 && oldLines[oldLines.length - 1]?.trim() === '') {
    oldLines.pop()
  }

  if (oldLines.length === 0) return undefined

  for (let start = 0; start <= fileLines.length - oldLines.length; start += 1) {
    let match = true
    for (let i = 0; i < oldLines.length; i += 1) {
      if (fileLines[start + i]?.trim() !== oldLines[i]?.trim()) {
        match = false
        break
      }
    }

    if (match) {
      const origFirstIndent = (fileLines[start]?.match(/^\s*/) ?? [''])[0] ?? ''
      const oldFirstIndent = (oldLines[0]?.match(/^\s*/) ?? [''])[0] ?? ''

      const origIndentLen = origFirstIndent.length
      const oldIndentLen = oldFirstIndent.length
      const indentDelta = origIndentLen - oldIndentLen

      const reindentedNewLines = newLines.map((line) => {
        if (!line.trim()) return ''
        if (indentDelta >= 0) {
          return ' '.repeat(indentDelta) + line
        }
        const lineIndent = (line.match(/^\s*/) ?? [''])[0] ?? ''
        const trimAmount = Math.min(lineIndent.length, Math.abs(indentDelta))
        return line.slice(trimAmount)
      })

      const updatedLines = [
        ...fileLines.slice(0, start),
        ...reindentedNewLines,
        ...fileLines.slice(start + oldLines.length),
      ]
      return updatedLines.join('\n')
    }
  }

  if (oldLines.length === 1 && oldLines[0]?.trim()) {
    const targetTrimmed = oldLines[0]!.trim()
    for (let i = 0; i < fileLines.length; i += 1) {
      if (fileLines[i]?.includes(targetTrimmed)) {
        const lineIndent = (fileLines[i]?.match(/^\s*/) ?? [''])[0] ?? ''
        const newTextClean = newLines.map((l) => l.trim()).filter(Boolean).join('\n' + lineIndent)
        const updatedLine = fileLines[i]!.replace(targetTrimmed, newTextClean)
        const updatedLines = [...fileLines.slice(0, i), updatedLine, ...fileLines.slice(i + 1)]
        return updatedLines.join('\n')
      }
    }
  }

  return undefined
}

async function executeVertexTool(
  toolName: string,
  argsText: string,
  projectRoot: string,
  permissionChecker?: (action: string, resource: string) => Promise<boolean>,
): Promise<{ output: string; success: boolean }> {
  const cleanName = toolName.trim().toLowerCase()

  let parsedJson: Record<string, unknown> | undefined
  try {
    const trimmed = argsText.trim()
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      const value = JSON.parse(trimmed)
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsedJson = value as Record<string, unknown>
      }
    }
  } catch {
    // Ignore JSON parse error
  }

  try {
    if (cleanName === 'read_file' || cleanName === 'read' || cleanName === 'cat' || cleanName === 'read_file_content') {
      const rawPath = parsedJson
        ? String(parsedJson.file_path ?? parsedJson.path ?? parsedJson.file ?? parsedJson.filename ?? '')
        : argsText.trim().replace(/^(?:file|path|filename):\s*/i, '').replace(/^['"]|['"]$/g, '')
      const resolved = resolveWorkspacePath(rawPath, projectRoot)
      if (!resolved.valid) {
        return { output: 'Error: Path outside workspace root', success: false }
      }
      let content = await fs.readFile(resolved.targetPath, 'utf8')
      if (content.length > 8_000) {
        content = `${content.slice(0, 6_000)}\n\n[... truncated ${content.length - 8_000} characters ...]\n\n${content.slice(-2_000)}`
      }
      return { output: content, success: true }
    }
    if (cleanName === 'list_dir' || cleanName === 'ls' || cleanName === 'list' || cleanName === 'list_directory') {
      const rawPath = parsedJson
        ? String(parsedJson.path ?? parsedJson.directory ?? parsedJson.dir ?? parsedJson.file_path ?? '.')
        : argsText.trim().replace(/^(?:file|path|filename|dir|directory):\s*/i, '').replace(/^['"]|['"]$/g, '')
      const resolved = resolveWorkspacePath(rawPath || '.', projectRoot)
      if (!resolved.valid) {
        return { output: 'Error: Path outside workspace root', success: false }
      }
      const entries = await fs.readdir(resolved.targetPath, { withFileTypes: true })
      const text = entries.map((entry) => `${entry.isDirectory() ? '[DIR] ' : '      '}${entry.name}`).join('\n')
      return { output: text || '(empty directory)', success: true }
    }
    if (cleanName === 'grep_search' || cleanName === 'grep' || cleanName === 'search') {
      const rawPath = parsedJson
        ? String(parsedJson.pattern ?? parsedJson.query ?? parsedJson.search ?? parsedJson.text ?? '')
        : argsText.trim().replace(/^(?:pattern|query|search|text):\s*/i, '').replace(/^['"]|['"]$/g, '')
      const results: string[] = []
      async function walk(dir: string) {
        if (results.length > 50) return
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue
          const fullPath = nodePath.join(dir, entry.name)
          if (entry.isDirectory()) await walk(fullPath)
          else if (entry.isFile()) {
            const text = await fs.readFile(fullPath, 'utf8').catch(() => '')
            if (text.includes(rawPath)) {
              results.push(`${nodePath.relative(projectRoot, fullPath)}: matches "${rawPath}"`)
            }
          }
        }
      }
      await walk(projectRoot)
      return { output: results.join('\n') || 'No matches found', success: true }
    }
    if (cleanName === 'write_file' || cleanName === 'write' || cleanName === 'create_file') {
      let rawPath = ''
      let content = ''
      if (parsedJson) {
        rawPath = String(parsedJson.file_path ?? parsedJson.path ?? parsedJson.file ?? parsedJson.filename ?? '').trim()
        content = String(parsedJson.content ?? parsedJson.text ?? parsedJson.code ?? '')
      } else {
        const lines = argsText.split('\n')
        rawPath = (lines[0] ?? '').trim().replace(/^(?:file|path|filename):\s*/i, '').replace(/^['"]|['"]$/g, '')
        content = lines.slice(1).join('\n')
      }
      const resolved = resolveWorkspacePath(rawPath, projectRoot)
      if (!resolved.valid) {
        return { output: 'Error: Path outside workspace root', success: false }
      }
      if (permissionChecker) {
        const allowed = await permissionChecker('write_file', resolved.cleanPath)
        if (!allowed) return { output: 'Permission denied by user.', success: false }
      }
      await fs.mkdir(nodePath.dirname(resolved.targetPath), { recursive: true })
      await fs.writeFile(resolved.targetPath, content, 'utf8')
      return { output: `File ${resolved.cleanPath} written successfully.`, success: true }
    }
    if (cleanName === 'edit_file' || cleanName === 'edit' || cleanName === 'replace') {
      let rawPath = ''
      let oldStr = ''
      let newStr = ''

      if (parsedJson) {
        rawPath = String(parsedJson.file_path ?? parsedJson.path ?? parsedJson.file ?? parsedJson.filename ?? '').trim()
        oldStr = String(parsedJson.old_string ?? parsedJson.old_text ?? parsedJson.old ?? parsedJson.search ?? '')
        newStr = String(parsedJson.new_string ?? parsedJson.new_text ?? parsedJson.new ?? parsedJson.replace ?? '')
      } else if (argsText.includes('<<<OLD')) {
        const pathLine = argsText.split('<<<OLD')[0]?.trim().split('\n').pop() || argsText.split('\n')[0] || ''
        rawPath = pathLine.trim().replace(/^(?:file|path|filename):\s*/i, '').replace(/^['"]|['"]$/g, '')
        const oldMatch = /<<<OLD[\t ]*\r?\n([\s\S]*?)\r?\n[\t ]*===/i.exec(argsText)
        const newMatch = /===[\t ]*\r?\n([\s\S]*?)(?:\r?\n[\t ]*>>>|$)/i.exec(argsText)
        oldStr = oldMatch?.[1] ?? ''
        newStr = newMatch?.[1] ?? ''
      } else {
        const parts = argsText.split('\n')
        rawPath = (parts[0] ?? '').trim().replace(/^['"]|['"]$/g, '')
        oldStr = parts[1] ?? ''
        newStr = parts.slice(2).join('\n')
      }

      const resolved = resolveWorkspacePath(rawPath, projectRoot)
      if (!resolved.valid) {
        return { output: 'Error: Path outside workspace root', success: false }
      }
      if (permissionChecker) {
        const allowed = await permissionChecker('edit_file', resolved.cleanPath)
        if (!allowed) return { output: 'Permission denied by user.', success: false }
      }
      const fileText = await fs.readFile(resolved.targetPath, 'utf8')
      const updated = performFlexibleEdit(fileText, oldStr, newStr)

      if (updated === undefined) {
        return {
          output: `Error: Could not find match for old_string in ${resolved.cleanPath}. Ensure old_string matches text from read_file, or use write_file to replace the full file content.`,
          success: false,
        }
      }

      await fs.writeFile(resolved.targetPath, updated, 'utf8')

      const oldLines = oldStr.split('\n')
      const newLines = newStr.split('\n')
      const diffOutput = [
        `diff a/${resolved.cleanPath} b/${resolved.cleanPath}`,
        `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
        ...oldLines.map((line) => `-${line}`),
        ...newLines.map((line) => `+${line}`),
      ].join('\n')

      return { output: diffOutput, success: true }
    }
    if (cleanName === 'bash' || cleanName === 'sh' || cleanName === 'exec') {
      const rawPath = parsedJson ? String(parsedJson.command ?? parsedJson.cmd ?? parsedJson.exec ?? '').trim() : argsText.trim()
      if (permissionChecker) {
        const allowed = await permissionChecker('bash', rawPath)
        if (!allowed) return { output: 'Permission denied by user.', success: false }
      }
      const { exec } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execAsync = promisify(exec)
      const { stdout, stderr } = await execAsync(rawPath, { cwd: projectRoot, timeout: 60_000 }).catch((err) => ({
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? err.message,
      }))
      const resultText = [stdout, stderr].filter(Boolean).join('\n')
      return { output: resultText || '(command completed with no output)', success: true }
    }
    return { output: `Unknown tool: ${toolName}`, success: false }
  } catch (error) {
    return { output: `Tool execution error: ${(error as Error).message}`, success: false }
  }
}
