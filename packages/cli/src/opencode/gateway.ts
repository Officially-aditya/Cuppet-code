import { EventEmitter } from 'node:events'
import type { createOpencodeClient } from '@opencode-ai/sdk/v2'
import type {
  IntegrationInfo as SDKIntegrationInfo,
  ModelV2Info,
  SessionV2Info,
} from '@opencode-ai/sdk/v2'
import type {
  AgentEvent,
  IntegrationInfo,
  ModelInfo,
  ModelRef,
  SessionInfo,
  TokenUsage,
} from '../types.js'

type Client = ReturnType<typeof createOpencodeClient>
type SdkResult<T> = { data?: T; error?: unknown; response?: Response }

export class OpenCodeGateway extends EventEmitter {
  readonly #client: Client
  readonly #directory: string
  readonly #eventAbort = new AbortController()
  #eventTask?: Promise<void>

  constructor(client: Client, directory: string) {
    super()
    this.#client = client
    this.#directory = directory
  }

  startEvents(): void {
    if (this.#eventTask) return
    this.#eventTask = this.#consumeEvents().catch((error) => {
      if (!this.#eventAbort.signal.aborted) this.emit('event', { type: 'error', message: message(error) } satisfies AgentEvent)
    })
  }

  async close(): Promise<void> {
    this.#eventAbort.abort()
    await this.#eventTask?.catch(() => undefined)
  }

  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.on('event', listener)
    return () => this.off('event', listener)
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await this.#client.v2.model.list({ location: { directory: this.#directory } })
    const result = unwrap(response as SdkResult<{ data: ModelV2Info[] }>)
    const models = result.data
      .flatMap((model) => {
        const cost = model.cost[0]
        return [undefined, ...model.variants.map((variant) => variant.id)].map((variant) => ({
          providerID: model.providerID,
          modelID: model.id,
          ...(variant ? { variant } : {}),
          name: `${model.name}${variant ? ` [${variant}]` : ''}`,
          context: model.limit.context,
          output: model.limit.output,
          enabled: model.enabled,
          status: model.status,
          inputCost: cost?.input ?? 0,
          outputCost: cost?.output ?? 0,
        }))
      })
      .filter((model) => model.enabled && model.status !== 'deprecated')

    const vertexModels: ModelInfo[] = [
      {
        providerID: 'vertex',
        modelID: 'gemini-3.6-flash',
        name: 'Gemini 3.6 Flash (Vertex AI ADC)',
        context: 1_000_000,
        output: 8192,
        enabled: true,
        status: 'active',
        inputCost: 0,
        outputCost: 0,
      },
      {
        providerID: 'vertex',
        modelID: 'gemini-3.5-flash',
        name: 'Gemini 3.5 Flash (Vertex AI ADC)',
        context: 1_000_000,
        output: 8192,
        enabled: true,
        status: 'active',
        inputCost: 0,
        outputCost: 0,
      },
      {
        providerID: 'vertex',
        modelID: 'gemini-3.5-flash-lite',
        name: 'Gemini 3.5 Flash Lite (Vertex AI ADC)',
        context: 1_000_000,
        output: 8192,
        enabled: true,
        status: 'active',
        inputCost: 0,
        outputCost: 0,
      },
      {
        providerID: 'vertex',
        modelID: 'gemini-3.1-pro-preview',
        name: 'Gemini 3.1 Pro Preview (Vertex AI ADC)',
        context: 2_000_000,
        output: 8192,
        enabled: true,
        status: 'active',
        inputCost: 0,
        outputCost: 0,
      },
      {
        providerID: 'vertex',
        modelID: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash (Vertex AI ADC)',
        context: 1_000_000,
        output: 8192,
        enabled: true,
        status: 'active',
        inputCost: 0,
        outputCost: 0,
      },
      {
        providerID: 'vertex',
        modelID: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro (Vertex AI ADC)',
        context: 2_000_000,
        output: 8192,
        enabled: true,
        status: 'active',
        inputCost: 0,
        outputCost: 0,
      },
    ]

    return [...models, ...vertexModels]
  }

  async listIntegrations(): Promise<IntegrationInfo[]> {
    const response = await this.#client.v2.integration.list({ location: { directory: this.#directory } })
    const result = unwrap(response as SdkResult<{ data: SDKIntegrationInfo[] }>)
    const integrations = result.data as IntegrationInfo[]
    const vertexIntegration: IntegrationInfo = {
      id: 'vertex',
      name: 'Google Cloud Vertex AI (ADC)',
      methods: [
        {
          type: 'env',
          names: ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT'],
        },
      ],
      connections: process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_CLOUD_PROJECT
        ? [{ type: 'env', label: 'ADC Active' }]
        : [],
    }
    return [...integrations, vertexIntegration]
  }

  async connectKey(integrationID: string, key: string): Promise<void> {
    ensureSuccess(
      (await this.#client.v2.integration.connect.key({
        integrationID,
        location: { directory: this.#directory },
        key,
      })) as SdkResult<unknown>,
    )
  }

  async beginOAuth(integrationID: string, methodID: string, inputs?: Record<string, string>) {
    return unwrap(
      (await this.#client.v2.integration.connect.oauth({
        integrationID,
        location: { directory: this.#directory },
        methodID,
        inputs: inputs ?? {},
      })) as unknown as SdkResult<{
        data: { attemptID: string; url: string; instructions: string; mode: 'auto' | 'code' }
      }>,
    ).data
  }

  async completeOAuth(attemptID: string, code: string): Promise<void> {
    ensureSuccess(
      (await this.#client.v2.integration.attempt.complete({
        attemptID,
        location: { directory: this.#directory },
        code,
      })) as SdkResult<unknown>,
    )
  }

  async oauthStatus(attemptID: string): Promise<{ status: string; message?: string }> {
    return unwrap(
      (await this.#client.v2.integration.attempt.status({
        attemptID,
        location: { directory: this.#directory },
      })) as unknown as SdkResult<{ data: { status: string; message?: string } }>,
    ).data
  }

  async cancelOAuth(attemptID: string): Promise<void> {
    ensureSuccess(
      (await this.#client.v2.integration.attempt.cancel({
        attemptID,
        location: { directory: this.#directory },
      })) as SdkResult<unknown>,
    )
  }

  async listSessions(): Promise<SessionInfo[]> {
    const response = await this.#client.v2.session.list({
      directory: this.#directory,
      order: 'desc',
      limit: 100,
    })
    const result = unwrap(response as SdkResult<{ data: SessionV2Info[] }>)
    return result.data.map(mapSession)
  }

  async createSession(model: ModelRef, background = false): Promise<SessionInfo> {
    const result = unwrap(
      (await this.#client.v2.session.create({
        agent: background ? 'cuppet-background' : 'cuppet',
        model: toSdkModel(model),
        location: { directory: this.#directory },
      })) as unknown as SdkResult<{ data: SessionV2Info }>,
    )
    return mapSession(result.data)
  }

  async getSession(sessionID: string): Promise<SessionInfo> {
    const result = unwrap(
      (await this.#client.v2.session.get({ sessionID })) as unknown as SdkResult<{ data: SessionV2Info }>,
    )
    return mapSession(result.data)
  }

  async switchModel(sessionID: string, model: ModelRef): Promise<void> {
    ensureSuccess(
      (await this.#client.v2.session.switchModel({ sessionID, model: toSdkModel(model) })) as SdkResult<unknown>,
    )
  }

  async prompt(sessionID: string, text: string, delivery: 'queue' | 'steer' = 'queue'): Promise<void> {
    ensureSuccess(
      (await this.#client.v2.session.prompt({
        sessionID,
        prompt: { text },
        delivery,
        resume: true,
      })) as SdkResult<unknown>,
    )
  }

  async wait(sessionID: string): Promise<void> {
    ensureSuccess((await this.#client.v2.session.wait({ sessionID })) as SdkResult<unknown>)
  }

  async messages(sessionID: string): Promise<unknown[]> {
    const result = unwrap(
      (await this.#client.v2.session.messages({ sessionID, order: 'asc', limit: 200 })) as SdkResult<{
        data: unknown[]
      }>,
    )
    return result.data
  }

  async interrupt(sessionID: string): Promise<void> {
    ensureSuccess((await this.#client.v2.session.interrupt({ sessionID })) as SdkResult<unknown>)
  }

  async compact(sessionID: string): Promise<void> {
    ensureSuccess((await this.#client.v2.session.compact({ sessionID })) as SdkResult<unknown>)
  }

  async undo(sessionID: string): Promise<void> {
    ensureSuccess(
      (await this.#client.v2.session.revert.stage({ sessionID, files: true })) as SdkResult<unknown>,
    )
    ensureSuccess((await this.#client.v2.session.revert.commit({ sessionID })) as SdkResult<unknown>)
  }

  async replyPermission(
    sessionID: string,
    requestID: string,
    reply: 'once' | 'always' | 'reject',
  ): Promise<void> {
    ensureSuccess(
      (await this.#client.v2.session.permission.reply({ sessionID, requestID, reply })) as SdkResult<unknown>,
    )
  }

  async denyPendingPermissions(sessionID: string): Promise<number> {
    const pending = unwrap(
      (await this.#client.v2.session.permission.list({ sessionID })) as unknown as SdkResult<{
        data: Array<{ id: string }>
      }>,
    ).data
    for (const request of pending) {
      await this.replyPermission(sessionID, request.id, 'reject')
    }
    return pending.length
  }

  async #consumeEvents(): Promise<void> {
    while (!this.#eventAbort.signal.aborted) {
      try {
        const events = await this.#client.v2.event.subscribe({ signal: this.#eventAbort.signal })
        for await (const raw of events.stream) {
          if (this.#eventAbort.signal.aborted) return
          const event = normalizeEvent(raw)
          if (event) this.emit('event', event)
        }
      } catch (error) {
        if (this.#eventAbort.signal.aborted) return
        this.emit('event', { type: 'error', message: `SSE reconnect: ${message(error)}` } satisfies AgentEvent)
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
  }

}

function normalizeEvent(raw: unknown): AgentEvent | undefined {
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
    case 'session.next.text.delta':
      return sessionID ? { type: 'text-delta', sessionID, text: String(data.delta ?? '') } : undefined
    case 'session.next.reasoning.delta':
      return sessionID ? { type: 'reasoning-delta', sessionID, text: String(data.delta ?? '') } : undefined
    case 'session.next.tool.called':
    case 'session.next.tool.input.started':
      return sessionID
        ? {
            type: 'tool-start',
            sessionID,
            callID: String(data.callID ?? ''),
            name: String(data.name ?? data.tool ?? 'tool'),
            ...(data.input !== undefined || data.args !== undefined || data.parameters !== undefined || data.params !== undefined
              ? { input: data.input ?? data.args ?? data.parameters ?? data.params }
              : { input: data }),
          }
        : undefined
    case 'session.next.tool.progress':
      return sessionID
        ? {
            type: 'tool-progress',
            sessionID,
            callID: String(data.callID ?? ''),
            message: String(data.message ?? data.title ?? 'working'),
          }
        : undefined
    case 'session.next.tool.success':
    case 'session.next.tool.failed':
      return sessionID
        ? {
            type: 'tool-end',
            sessionID,
            callID: String(data.callID ?? ''),
            success: type.endsWith('success'),
            ...(Array.isArray(data.outputPaths) ? { outputPaths: data.outputPaths.map(String) } : {}),
          }
        : undefined
    case 'session.diff':
      return sessionID && Array.isArray(data.diff) ? { type: 'diff', sessionID, diff: data.diff } : undefined
    case 'permission.v2.asked':
      return typeof data.id === 'string' && sessionID
        ? {
            type: 'permission',
            request: {
              id: data.id,
              sessionID,
              action: String(data.action ?? 'unknown'),
              resources: Array.isArray(data.resources) ? data.resources.map(String) : [],
              ...(Array.isArray(data.save) ? { save: data.save.map(String) } : {}),
              ...(recordOrUndefined(data.metadata) ? { metadata: record(data.metadata) } : {}),
            },
          }
        : undefined
    case 'session.next.step.ended':
    case 'session.step.ended':
    case 'step.ended':
    case 'session.usage':
      return sessionID
        ? {
            type: 'usage',
            sessionID,
            usage: mapUsage(record(data.tokens ?? data.usage ?? record(data.step).tokens)),
            cost: Number(data.cost ?? 0),
          }
        : undefined
    case 'session.next.compaction.started':
      return sessionID ? { type: 'compaction', sessionID, phase: 'started' } : undefined
    case 'session.next.compaction.ended':
      return sessionID ? { type: 'compaction', sessionID, phase: 'ended' } : undefined
    case 'session.idle':
      return sessionID ? { type: 'idle', sessionID } : undefined
    case 'session.error':
      return { type: 'error', ...(sessionID ? { sessionID } : {}), message: message(data.error) }
    default:
      return undefined
  }
}

function mapSession(session: SessionV2Info): SessionInfo {
  return {
    id: session.id,
    title: session.title,
    ...(session.agent ? { agent: session.agent } : {}),
    ...(session.model
      ? {
          model: {
            providerID: session.model.providerID,
            modelID: session.model.id,
            ...(session.model.variant ? { variant: session.model.variant } : {}),
          },
        }
      : {}),
    cost: session.cost,
    tokens: mapUsage(session.tokens),
    updated: session.time.updated,
  }
}

function mapUsage(tokens: Record<string, unknown> | SessionV2Info['tokens']): TokenUsage {
  const recordTokens = record(tokens)
  const cache = record(recordTokens.cache)
  const input = Number(recordTokens.input ?? recordTokens.prompt ?? recordTokens.input_tokens ?? recordTokens.prompt_tokens ?? 0)
  const output = Number(recordTokens.output ?? recordTokens.completion ?? recordTokens.output_tokens ?? recordTokens.completion_tokens ?? 0)
  const reasoning = Number(recordTokens.reasoning ?? recordTokens.reasoning_tokens ?? 0)
  const cacheRead = Number(cache.read ?? cache.read_tokens ?? recordTokens.cache_read_input_tokens ?? 0)
  const cacheWrite = Number(cache.write ?? cache.write_tokens ?? recordTokens.cache_creation_input_tokens ?? 0)
  return { input, output, reasoning, cacheRead, cacheWrite }
}

function toSdkModel(model: ModelRef) {
  return {
    id: model.modelID,
    providerID: model.providerID,
    ...(model.variant ? { variant: model.variant } : {}),
  }
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
