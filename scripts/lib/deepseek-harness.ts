import { access, copyFile, lstat, mkdtemp, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export type DeepSeekHarnessEvent = {
  type?: unknown
  data?: {
    message?: { content?: unknown }
    usage?: Record<string, unknown>
    reason?: { error?: { message?: unknown } }
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
  cordisConfig?: string
  dshHome?: string
  model?: string
  provider?: string
  maxTokens?: number
  requestTimeoutMs?: number
  baseURL?: string
  apiKey?: string
  systemPrompt?: string
}

export const DEEPSEEK_HARNESS_CODING_SYSTEM_PROMPT =
  'Work directly in the assigned workspace and make one coherent implementation pass. Use str_replace_editor for file edits. The external benchmark evaluator owns tests, typechecking, and CLI validation: do not create bespoke diagnostic scripts, repeatedly rewrite tests, or debug by trial and error. Create only the required source, focused test, and package-script files, inspect each once as needed, then stop. Do not use unavailable tools, access credentials, or access the network from workspace tools.'

export async function createDeepSeekHarness(options: DeepSeekHarnessOptions): Promise<RuntimeHarness> {
  const harnessRoot = resolve(options.harnessRoot ?? process.env.CUPPET_DSH_ROOT ?? join(process.cwd(), '.benchmarks', 'deepseek-harness'))
  const runner = join(
    harnessRoot,
    'python',
    'sdk-runtime',
    'node_modules',
    '@deepseek-ai',
    'dsh-sdk-jsonrpc-demo',
    'lib',
    'packaged-bin.js',
  )
  const requestedConfig = resolve(options.cordisConfig ?? join(harnessRoot, 'examples', 'jsonrpc-agent', 'minimal.cordis.yml'))
  let stagedConfigRoot: string | undefined
  const config = options.cordisConfig === undefined
    ? requestedConfig
    : await (async () => {
      await access(requestedConfig)
      stagedConfigRoot = await mkdtemp(join(harnessRoot, '.cuppet-cordis-'))
      const stagedConfig = join(stagedConfigRoot, 'config.cordis.yml')
      await copyFile(requestedConfig, stagedConfig)
      return stagedConfig
    })()
  try {
    await Promise.all([access(runner), access(config)])
  } catch (error) {
    if (stagedConfigRoot) await rm(stagedConfigRoot, { recursive: true, force: true })
    throw error
  }
  const runtimeCredentialPluginLink = join(
    harnessRoot,
    'python',
    'sdk-runtime',
    'node_modules',
    '@deepseek-ai',
    'dsh-credentials-local',
  )
  let createdRuntimeCredentialPluginLink = false
  try {
    await lstat(runtimeCredentialPluginLink)
  } catch {
    await symlink(
      join(harnessRoot, 'packages', 'credentials', 'credentials-local'),
      runtimeCredentialPluginLink,
    )
    createdRuntimeCredentialPluginLink = true
  }

  const cleanup = async (): Promise<void> => {
    if (createdRuntimeCredentialPluginLink) await rm(runtimeCredentialPluginLink, { force: true })
    if (stagedConfigRoot) await rm(stagedConfigRoot, { recursive: true, force: true })
  }

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
  if (options.dshHome) env.DSH_HOME = resolve(options.dshHome)
  if (options.baseURL) env.DEEPSEEK_BASE_URL = options.baseURL
  if (options.apiKey) env.DEEPSEEK_API_KEY = options.apiKey
  if (options.systemPrompt) env.DSH_SYSTEM_PROMPT = options.systemPrompt

  const runtime = new clientModule.DeepSeekHarness({
    launch: {
      command: process.execPath,
      args: ['--preserve-symlinks-main', runner],
      cwd: harnessRoot,
      env,
      ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
    },
    cwd: resolve(options.workspace),
    provider: options.provider ?? 'deepseek-official',
    model: options.model ?? 'deepseek-v4-flash',
    ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
  })
  return {
    run: (input, runOptions) => runtime.run(input, runOptions),
    close: async () => {
      try {
        await runtime.close()
      } finally {
        await cleanup()
      }
    },
  }
}

export async function runDeepSeekHarness(
  options: DeepSeekHarnessOptions,
  prompt: string,
  sessionID?: string,
): Promise<DeepSeekRun> {
  const harness = await createDeepSeekHarness(options)
  try {
    const result = await harness.run(prompt, sessionID === undefined ? undefined : { sessionId: sessionID })
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
