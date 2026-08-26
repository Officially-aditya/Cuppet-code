import { resolve } from 'node:path'
import { createDeepSeekHarness } from './deepseek-harness.js'
import { stageCuppetOpenAICodexCredentials, withCuppetOpenAICodexCredentials } from './cuppet-openai-codex.js'
import { summarizeDeepSeekEvents, type DeepSeekRun } from './deepseek-harness.js'

export type DeepSeekBenchmarkTarget = {
  provider: string
  model: string
  usesCuppetOpenAICodex: boolean
}

export type DeepSeekBenchmarkHarnessOptions = {
  workspace: string
  sessionRoot: string
  model: string
  provider?: string
  maxTokens?: number
  requestTimeoutMs?: number
  systemPrompt?: string
}

export function resolveDeepSeekBenchmarkTarget(model: string, providerOverride?: string): DeepSeekBenchmarkTarget {
  const provider = providerOverride?.trim() || process.env.CUPPET_DSH_PROVIDER?.trim() || 'deepseek-official'
  return {
    provider,
    model: process.env.CUPPET_DSH_MODEL?.trim() || model,
    usesCuppetOpenAICodex: provider === 'openai-codex',
  }
}

export type DeepSeekBenchmarkSession = {
  run(input: string, sessionID?: string): Promise<DeepSeekRun>
  close(): Promise<void>
}

export async function openDeepSeekBenchmarkSession(
  options: DeepSeekBenchmarkHarnessOptions,
): Promise<DeepSeekBenchmarkSession> {
  const target = resolveDeepSeekBenchmarkTarget(options.model, options.provider)
  const baseOptions = {
    ...options,
    model: target.model,
    provider: target.provider,
  }

  if (target.usesCuppetOpenAICodex) {
    const cordisConfig = process.env.CUPPET_DSH_CORDIS_CONFIG?.trim()
      || resolve(process.cwd(), 'benchmarks', 'configs', 'deepseek-harness-openai-codex.cordis.yml')
    const staged = await stageCuppetOpenAICodexCredentials()
    try {
      const session = await openHarnessSession({
        ...baseOptions,
        cordisConfig,
        dshHome: staged.dshHome,
      })
      return withCleanup(session, staged.cleanup)
    } catch (error) {
      await staged.cleanup()
      throw error
    }
  }

  return openHarnessSession({
    ...baseOptions,
    baseURL: process.env.CUPPET_DSH_BASE_URL ?? 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
  })
}

export async function withDeepSeekBenchmarkHarness<T>(
  options: DeepSeekBenchmarkHarnessOptions,
  run: (harness: Awaited<ReturnType<typeof createDeepSeekHarness>>) => Promise<T>,
): Promise<T> {
  const target = resolveDeepSeekBenchmarkTarget(options.model, options.provider)
  const baseOptions = {
    ...options,
    model: target.model,
    provider: target.provider,
  }

  if (target.usesCuppetOpenAICodex) {
    const cordisConfig = process.env.CUPPET_DSH_CORDIS_CONFIG?.trim()
      || resolve(process.cwd(), 'benchmarks', 'configs', 'deepseek-harness-openai-codex.cordis.yml')
    return withCuppetOpenAICodexCredentials((dshHome) => openHarness({
      ...baseOptions,
      cordisConfig,
      dshHome,
    }, run))
  }

  return openHarness({
    ...baseOptions,
    baseURL: process.env.CUPPET_DSH_BASE_URL ?? 'https://openrouter.ai/api/v1',
    apiKey: process.env.OPENROUTER_API_KEY,
  }, run)
}

async function openHarness<T>(
  options: Parameters<typeof createDeepSeekHarness>[0],
  run: (harness: Awaited<ReturnType<typeof createDeepSeekHarness>>) => Promise<T>,
): Promise<T> {
  const harness = await createDeepSeekHarness(options)
  try {
    return await run(harness)
  } finally {
    await harness.close()
  }
}

async function openHarnessSession(
  options: Parameters<typeof createDeepSeekHarness>[0],
): Promise<DeepSeekBenchmarkSession> {
  const harness = await createDeepSeekHarness(options)
  return {
    run: async (input, sessionID) => {
      const result = await harness.run(input, sessionID === undefined ? undefined : { sessionId: sessionID })
      const usage = summarizeDeepSeekEvents(result.events)
      if (usage.modelCalls === 0) {
        const failure = result.events.find((event) => typeof event.data?.reason?.error?.message === 'string')?.data?.reason?.error?.message
        throw new Error(typeof failure === 'string' ? failure : 'DeepSeek Harness returned no assistant model events')
      }
      return {
        sessionID: result.sessionId,
        answer: result.finalResponse,
        events: result.events,
        usage,
      }
    },
    close: () => harness.close(),
  }
}

function withCleanup(
  session: DeepSeekBenchmarkSession,
  cleanup: () => Promise<void>,
): DeepSeekBenchmarkSession {
  return {
    run: session.run,
    close: async () => {
      try {
        await session.close()
      } finally {
        await cleanup()
      }
    },
  }
}
