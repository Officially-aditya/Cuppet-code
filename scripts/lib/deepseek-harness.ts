import { access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export type DeepSeekHarnessEvent = {
  type?: unknown
  data?: {
    message?: { content?: unknown }
    usage?: Record<string, unknown>
  }
}

export type DeepSeekTokenTotals = {
  modelCalls: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  uncachedInputTokens: number
  totalModelTokens: number
  toolCalls: number
}

export type DeepSeekRun = {
  sessionID: string
  answer: string
  events: DeepSeekHarnessEvent[]
  usage: DeepSeekTokenTotals
}

type RuntimeHarness = {
  run(input: string, options?: { sessionId?: string }): Promise<{ sessionId: string; finalResponse: string; events: DeepSeekHarnessEvent[] }>
  close(): Promise<void>
}

export type DeepSeekHarnessOptions = {
  workspace: string
  sessionRoot: string
  harnessRoot?: string
  model?: string
  provider?: string
  maxTokens?: number
  requestTimeoutMs?: number
  baseURL?: string
  apiKey?: string
}

export async function createDeepSeekHarness(options: DeepSeekHarnessOptions): Promise<RuntimeHarness> {
  const harnessRoot = resolve(options.harnessRoot ?? process.env.CUPPET_DSH_ROOT ?? join(process.cwd(), '.benchmarks', 'deepseek-harness'))
  const runner = join(harnessRoot, 'packages', 'examples', 'jsonrpc-demo', 'lib', 'bin.js')
  const config = join(harnessRoot, 'examples', 'jsonrpc-agent', 'minimal.cordis.yml')
  await Promise.all([access(runner), access(config)])

  const clientModule = await import(pathToFileURL(join(harnessRoot, 'packages', 'sdk', 'client', 'lib', 'index.js')).href) as {
    DeepSeekHarness: new (options: {
      launch: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; requestTimeoutMs?: number }
      cwd: string
      provider: string
      model: string
      maxTokens?: number
    }) => RuntimeHarness
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_CORDIS_CONFIG: config,
    DSH_CWD: resolve(options.workspace),
    DSH_MODEL: options.model ?? 'deepseek-v4-flash',
    DSH_SESSION_ROOT: resolve(options.sessionRoot),
  }
  if (options.baseURL) env.DEEPSEEK_BASE_URL = options.baseURL
  if (options.apiKey) env.DEEPSEEK_API_KEY = options.apiKey

  return new clientModule.DeepSeekHarness({
    launch: {
      command: process.execPath,
      args: [runner],
      cwd: harnessRoot,
      env,
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    },
    cwd: resolve(options.workspace),
    provider: options.provider ?? 'deepseek-official',
    model: options.model ?? 'deepseek-v4-flash',
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
  })
}

export async function runDeepSeekHarness(
  options: DeepSeekHarnessOptions,
  prompt: string,
  sessionID?: string,
): Promise<DeepSeekRun> {
  const harness = await createDeepSeekHarness(options)
  try {
    const result = await harness.run(prompt, sessionID === undefined ? undefined : { sessionId: sessionID })
    return {
      sessionID: result.sessionId,
      answer: result.finalResponse,
      events: result.events,
      usage: summarizeDeepSeekEvents(result.events),
    }
  } finally {
    await harness.close()
  }
}

export function summarizeDeepSeekEvents(events: readonly DeepSeekHarnessEvent[]): DeepSeekTokenTotals {
  const totals: DeepSeekTokenTotals = {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    uncachedInputTokens: 0,
    totalModelTokens: 0,
    toolCalls: 0,
  }
  for (const event of events) {
    if (event.type !== 'assistant/message') continue
    totals.modelCalls += 1
    const usage = event.data?.usage
    totals.inputTokens += numberValue(usage?.inputTokens)
    totals.outputTokens += numberValue(usage?.outputTokens)
    totals.reasoningTokens += numberValue(usage?.reasoningTokens)
    totals.cacheReadTokens += numberValue(usage?.cacheReadTokens)
    totals.cacheWriteTokens += numberValue(usage?.cacheWriteTokens)
    const content = event.data?.message?.content
    if (Array.isArray(content)) {
      totals.toolCalls += content.filter((block) => isRecord(block) && block.type === 'tool-call').length
    }
  }
  totals.uncachedInputTokens = totals.inputTokens
  totals.totalModelTokens = totals.inputTokens + totals.outputTokens + totals.reasoningTokens
  return totals
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
