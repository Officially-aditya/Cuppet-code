import { resolve } from 'node:path'
import { createDeepSeekHarness } from './deepseek-harness.js'
import { withCuppetOpenAICodexCredentials } from './cuppet-openai-codex.js'

export type DeepSeekBenchmarkTarget = {
  provider: string
  model: string
  usesCuppetOpenAICodex: boolean
}

export type DeepSeekBenchmarkHarnessOptions = {
  workspace: string
  sessionRoot: string
  model: string
  maxTokens?: number
  requestTimeoutMs?: number
  systemPrompt?: string
}

export function resolveDeepSeekBenchmarkTarget(model: string): DeepSeekBenchmarkTarget {
  const provider = process.env.CUPPET_DSH_PROVIDER?.trim() || 'deepseek-official'
  return {
    provider,
    model: process.env.CUPPET_DSH_MODEL?.trim() || model,
    usesCuppetOpenAICodex: provider === 'openai-codex',
  }
}

export async function withDeepSeekBenchmarkHarness<T>(
  options: DeepSeekBenchmarkHarnessOptions,
  run: (harness: Awaited<ReturnType<typeof createDeepSeekHarness>>) => Promise<T>,
): Promise<T> {
  const target = resolveDeepSeekBenchmarkTarget(options.model)
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
