import { cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PreferenceStore } from '../packages/cli/src/config/preferences.js'
import { OpenCodeGateway } from '../packages/cli/src/opencode/gateway.js'
import { startOpenCodeServer, type OpenCodeRuntime } from '../packages/cli/src/opencode/server.js'
import { resolveRuntimeAssets } from '../packages/cli/src/runtime/assets.js'
import { RedactedLogger } from '../packages/cli/src/runtime/logger.js'
import { createRuntimePaths } from '../packages/cli/src/runtime/paths.js'
import { buildCuppetContext } from '../packages/cli/src/tst/context.js'
import { startTstDaemon, type TstRuntime } from '../packages/cli/src/tst/supervisor.js'
import type { AgentEvent, ModelRef, TokenUsage } from '../packages/cli/src/types.js'

type Arm = 'opencode' | 'cuppet'
type Task = { id: string; prompt: string; expected: string[] }
type Trial = {
  task: string
  arm: Arm
  sessionID: string
  success: boolean
  expected: string[]
  answer: string
  durationMs: number
  contextTokens: number
  expectedCoverage: number
  toolCalls: number
  graphCalls: number
  graphOutputBytes: number
  graphToolTrace: Array<{
    name: string
    input: unknown
    outputBytes: number
    resultCount: number
    truncated: boolean
    cacheHit: boolean
  }>
  usage: TokenUsage
  uncachedInputTokens: number
  cost: number
  error?: string
}

const tasks: Task[] = [
  {
    id: 'vertex-runtime',
    prompt: 'Read-only code navigation task. Identify the source file and function that resolve Vertex ADC, project, and location environment settings. Answer with only: <path> :: <function>. Do not modify files.',
    expected: ['packages/cli/src/opencode/server.ts', 'resolveVertexEnvironment'],
  },
  {
    id: 'context-builder',
    prompt: 'Read-only code navigation task. Identify the source file and function that construct the CUPPET_CONTEXT block. Answer with only: <path> :: <function>. Do not modify files.',
    expected: ['packages/cli/src/tst/context.ts', 'buildCuppetContext'],
  },
  {
    id: 'graph-budget',
    prompt: 'Read-only code navigation task. Identify the Rust source file and method that divide a memory query limit among STM, LTM, and graph results. Answer with only: <path> :: <method>. Do not modify files.',
    expected: ['crates/tst-core/src/service.rs', 'query'],
  },
  {
    id: 'diff-colors',
    prompt: 'Read-only code navigation task. Identify the source file and function that decide green, red, or cyan coloring for rendered diff lines. Answer with only: <path> :: <function>. Do not modify files.',
    expected: ['packages/cli/src/ui/TerminalApp.tsx', 'diffLineColor'],
  },
  {
    id: 'token-total',
    prompt: 'Read-only code navigation task. Identify the source file and function that calculate the displayed foreground token total without cache double-counting. Answer with only: <path> :: <function>. Do not modify files.',
    expected: ['packages/cli/src/usage.ts', 'totalTokenUsage'],
  },
]
const taskLimit = Math.max(1, Math.min(tasks.length, Number(process.env.CUPPET_AB_LIMIT ?? tasks.length) || tasks.length))
const taskOffset = Math.max(0, Math.min(tasks.length - 1, Number(process.env.CUPPET_AB_TASK_OFFSET ?? '0') || 0))
const selectedTasks = tasks.slice(taskOffset, taskOffset + taskLimit)
const persistentGraph = process.env.CUPPET_AB_PERSISTENT_GRAPH === '1'

const project = resolve(process.cwd())
const base = await mkdtemp(join(tmpdir(), 'cuppet-ab-'))
const paths = await createRuntimePaths(project, base)
const logger = new RedactedLogger(paths.logs)
const assets = await resolveRuntimeAssets()
if (!assets.opencode || !assets.tst) throw new Error(`Evaluation runtimes unavailable: ${assets.diagnostics.join('; ')}`)

const globalPreferences = new PreferenceStore(join(process.env.HOME ?? '', '.cuppet', 'v2', 'preferences.json'))
await globalPreferences.load()
const configuredModel = globalPreferences.value.primary
const model = parseModel(process.env.CUPPET_AB_MODEL, process.env.CUPPET_AB_VARIANT) ?? configuredModel ?? {
  providerID: 'google-vertex',
  modelID: 'gemini-flash-latest',
}

let tst: TstRuntime | undefined
let opencode: OpenCodeRuntime | undefined
let gateway: OpenCodeGateway | undefined
const trials: Trial[] = []

try {
  await seedOpenCodeProviderState(paths)
  let activeTst = await startTstDaemon(assets.tst, paths, logger)
  tst = activeTst
  let graphPersistence: Awaited<ReturnType<typeof restartAgainstGraphSnapshot>> | undefined
  if (persistentGraph) {
    graphPersistence = await restartAgainstGraphSnapshot(activeTst, assets.tst, paths, logger)
    activeTst = graphPersistence.runtime
    tst = activeTst
  }
  await waitForIndex(activeTst)
  opencode = await startOpenCodeServer({
    binary: assets.opencode,
    paths,
    logger,
    ...(assets.plugin ? { plugin: assets.plugin } : {}),
    tst: { socket: activeTst.socket, token: activeTst.token },
    ...(globalPreferences.value.vertexProject ? { vertexProject: globalPreferences.value.vertexProject } : {}),
  })
  gateway = new OpenCodeGateway(opencode.client, project)
  const pending = new Set<string>()
  const errors = new Map<string, string>()
  const toolCalls = new Map<string, number>()
  const graphCalls = new Map<string, number>()
  const graphOutputBytes = new Map<string, number>()
  const graphToolTrace = new Map<string, Trial['graphToolTrace']>()
  const toolNamesByCallID = new Map<string, string>()
  gateway.onEvent((event) => {
    if (event.type === 'permission' && !pending.has(event.request.id)) {
      pending.add(event.request.id)
      // Evaluation tasks are read-only. Reject any unexpected mutation/shell request identically.
      void gateway?.replyPermission(event.request.sessionID, event.request.id, 'reject')
    }
    if (event.type === 'tool-start') {
      toolCalls.set(event.sessionID, (toolCalls.get(event.sessionID) ?? 0) + 1)
      toolNamesByCallID.set(event.callID, event.name)
      if (isGraphTool(event.name)) {
        graphCalls.set(event.sessionID, (graphCalls.get(event.sessionID) ?? 0) + 1)
      }
    }
    if (event.type === 'tool-end') {
      const name = toolNamesByCallID.get(event.callID) ?? event.name ?? 'tool'
      if (isGraphTool(name)) {
        graphOutputBytes.set(event.sessionID, (graphOutputBytes.get(event.sessionID) ?? 0) + event.outputBytes)
        const traces = graphToolTrace.get(event.sessionID) ?? []
        // Exact arguments are deliberately retained only in this disposable
        // benchmark result, never in normal controller telemetry.
        traces.push({
          name,
          input: event.input ?? null,
          outputBytes: event.outputBytes,
          resultCount: event.resultCount,
          truncated: event.truncated,
          cacheHit: event.cacheHit,
        })
        graphToolTrace.set(event.sessionID, traces)
      }
    }
    if (event.type === 'error' && event.sessionID) errors.set(event.sessionID, event.message)
  })
  gateway.startEvents()

  for (let index = 0; index < selectedTasks.length; index += 1) {
    const task = selectedTasks[index]!
    const order: Arm[] = index % 2 === 0 ? ['opencode', 'cuppet'] : ['cuppet', 'opencode']
    for (const arm of order) {
      process.stdout.write(`[${index + 1}/${selectedTasks.length}] ${task.id} · ${arm}\n`)
      const session = await gateway.createSession(model)
      const enriched = arm === 'cuppet'
        ? await buildCuppetContext(activeTst.client, session.id, task.prompt, 1_048_576, [], '', project)
        : { prompt: task.prompt, contextTokens: 0 }
      const started = performance.now()
      let answer = ''
      let failure: string | undefined
      try {
        await gateway.prompt(session.id, enriched.prompt)
        await withTimeout(gateway.wait(session.id), 10 * 60_000, `${arm}/${task.id} timed out`)
        answer = assistantText(await gateway.messages(session.id))
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
      const completed = await gateway.getSession(session.id)
      const eventError = errors.get(session.id)
      const normalizedAnswer = answer.toLowerCase()
      const expectedCoverage = ratio(
        task.expected.filter((item) => normalizedAnswer.includes(item.toLowerCase())).length,
        task.expected.length,
      )
      trials.push({
        task: task.id,
        arm,
        sessionID: session.id,
        success: !failure && !eventError && expectedCoverage === 1,
        expected: task.expected,
        answer,
        durationMs: Math.round(performance.now() - started),
        contextTokens: enriched.contextTokens,
        expectedCoverage,
        toolCalls: toolCalls.get(session.id) ?? 0,
        graphCalls: graphCalls.get(session.id) ?? 0,
        graphOutputBytes: graphOutputBytes.get(session.id) ?? 0,
        graphToolTrace: graphToolTrace.get(session.id) ?? [],
        usage: completed.tokens,
        // OpenCode records cache reads/writes separately; input is the uncached-input counter.
        uncachedInputTokens: completed.tokens.input,
        cost: completed.cost,
        ...(failure || eventError ? { error: failure ?? eventError } : {}),
      })
    }
  }

  const report = {
    schema: 1,
    createdAt: new Date().toISOString(),
    project,
    opencodeVersion: '1.18.4',
    model,
    taskOffset,
    design: persistentGraph
      ? 'paired fresh sessions; shared OpenCode server/kernel; identical read-only tools and permissions; alternating arm order; Cuppet graph is built once, daemon-restarted from its project snapshot, then fully revalidated before trials'
      : 'paired fresh sessions; shared OpenCode server/kernel; identical read-only tools and permissions; alternating arm order',
    ...(graphPersistence ? { graphPersistence: graphPersistence.metrics } : {}),
    summary: summarize(trials),
    trials,
  }
  const outputDirectory = resolve(project, 'benchmarks', 'results')
  await mkdir(outputDirectory, { recursive: true })
  const output = join(outputDirectory, `ab-${new Date().toISOString().replaceAll(':', '-')}.json`)
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\nResult: ${output}\n`)
} finally {
  gateway?.close()
  await opencode?.close().catch(() => undefined)
  await tst?.close().catch(() => undefined)
  await rm(base, { recursive: true, force: true }).catch(() => undefined)
}

function parseModel(value: string | undefined, variant: string | undefined): ModelRef | undefined {
  if (!value) return undefined
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) throw new Error('CUPPET_AB_MODEL must be provider/model')
  return {
    providerID: value.slice(0, slash),
    modelID: value.slice(slash + 1),
    ...(variant ? { variant } : {}),
  }
}

async function seedOpenCodeProviderState(paths: Awaited<ReturnType<typeof createRuntimePaths>>): Promise<void> {
  const persistentRoot = join(process.env.HOME ?? '', '.cuppet', 'v2', 'opencode')
  const files = [
    { source: join(persistentRoot, 'data', 'opencode', 'auth.json'), target: join(paths.opencode.data, 'opencode', 'auth.json') },
    { source: join(persistentRoot, 'data', 'opencode', 'opencode.db'), target: join(paths.opencode.data, 'opencode', 'opencode.db') },
    { source: join(persistentRoot, 'data', 'opencode', 'opencode.db-wal'), target: join(paths.opencode.data, 'opencode', 'opencode.db-wal') },
    { source: join(persistentRoot, 'data', 'opencode', 'opencode.db-shm'), target: join(paths.opencode.data, 'opencode', 'opencode.db-shm') },
    { source: join(persistentRoot, 'cache', 'opencode', 'models.json'), target: join(paths.opencode.cache, 'opencode', 'models.json') },
  ]
  for (const file of files) {
    try {
      await mkdir(dirname(file.target), { recursive: true, mode: 0o700 })
      await cp(file.source, file.target, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

async function restartAgainstGraphSnapshot(
  first: TstRuntime,
  binary: string,
  paths: Awaited<ReturnType<typeof createRuntimePaths>>,
  logger: RedactedLogger,
): Promise<{ runtime: TstRuntime; metrics: Record<string, number | boolean> }> {
  const coldIndexStarted = performance.now()
  await waitForIndex(first)
  const coldIndexMs = Math.round(performance.now() - coldIndexStarted)
  const snapshot = await stat(join(paths.projectStore, 'graph.msgpack'))
  await first.close()

  const warmStartStarted = performance.now()
  const runtime = await startTstDaemon(binary, paths, logger)
  const warmDaemonStartMs = Math.round(performance.now() - warmStartStarted)
  const statusBeforeProbe = await runtime.client.call<{ graph?: { progress?: { complete?: boolean } } }>('status')
  const warmQueryStarted = performance.now()
  const search = await runtime.client.call<{ nodes?: Array<{ node?: { name?: string } }> }>('graph.search', {
    pattern: 'buildCuppetContext',
    limit: 5,
  })
  const warmFirstGraphQueryMs = Math.round(performance.now() - warmQueryStarted)
  const snapshotQueryMatched = Boolean(search.nodes?.some((result) => result.node?.name === 'buildCuppetContext'))
  if (!snapshotQueryMatched) {
    await runtime.close().catch(() => undefined)
    throw new Error('persisted graph snapshot was not queryable after daemon restart')
  }

  return {
    runtime,
    metrics: {
      coldIndexMs,
      snapshotBytes: snapshot.size,
      warmDaemonStartMs,
      warmFirstGraphQueryMs,
      snapshotQueryMatched,
      revalidationAlreadyCompleteBeforeProbe: Boolean(statusBeforeProbe.graph?.progress?.complete),
    },
  }
}

async function waitForIndex(runtime: TstRuntime): Promise<void> {
  const deadline = Date.now() + 3 * 60_000
  while (Date.now() < deadline) {
    const status = await runtime.client.call<{ graph?: { progress?: { complete?: boolean; indexed?: number; discovered?: number } } }>('status')
    const progress = status.graph?.progress
    if (progress?.complete) return
    process.stdout.write(`Indexing ${progress?.indexed ?? 0}/${progress?.discovered ?? '?'}\r`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error('Timed out waiting for the code graph index')
}

function assistantText(messages: unknown[]): string {
  const output: string[] = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const record = message as { info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }
    if (record.info?.role !== 'assistant') continue
    for (const part of record.parts ?? []) {
      if (part.type === 'text' && part.text) output.push(part.text)
    }
  }
  return output.join('\n').trim()
}

function summarize(values: Trial[]) {
  const armSummary = (arm: Arm) => {
    const selected = values.filter((trial) => trial.arm === arm)
    const successful = selected.filter((trial) => trial.success)
    return {
      trials: selected.length,
      successes: successful.length,
      completionRate: ratio(successful.length, selected.length),
      medianUncachedInputTokensPerSuccess: median(successful.map((trial) => trial.uncachedInputTokens)),
      medianDurationMsPerSuccess: median(successful.map((trial) => trial.durationMs)),
      medianCostPerSuccess: median(successful.map((trial) => trial.cost)),
      medianTotalModelTokensPerSuccess: median(successful.map((trial) => totalModelTokens(trial.usage))),
      meanExpectedCoverage: mean(selected.map((trial) => trial.expectedCoverage)),
      meanToolCalls: mean(selected.map((trial) => trial.toolCalls)),
      meanGraphCalls: mean(selected.map((trial) => trial.graphCalls)),
      meanGraphOutputBytes: mean(selected.map((trial) => trial.graphOutputBytes)),
      costTelemetryAvailable: selected.some((trial) => trial.cost > 0),
      totalCost: selected.reduce((sum, trial) => sum + trial.cost, 0),
      medianInjectedContextTokens: median(selected.map((trial) => trial.contextTokens)),
    }
  }
  const summary = { opencode: armSummary('opencode'), cuppet: armSummary('cuppet') }
  const baseline = summary.opencode
  const cuppet = summary.cuppet
  return {
    ...summary,
    comparison: {
      uncachedInputReduction: ratio(
        baseline.medianUncachedInputTokensPerSuccess - cuppet.medianUncachedInputTokensPerSuccess,
        baseline.medianUncachedInputTokensPerSuccess,
      ),
      completionRateDelta: cuppet.completionRate - baseline.completionRate,
      medianLatencyDeltaMsPerSuccess: cuppet.medianDurationMsPerSuccess - baseline.medianDurationMsPerSuccess,
      medianLatencyReduction: ratio(
        baseline.medianDurationMsPerSuccess - cuppet.medianDurationMsPerSuccess,
        baseline.medianDurationMsPerSuccess,
      ),
      medianCostDeltaPerSuccess: cuppet.medianCostPerSuccess - baseline.medianCostPerSuccess,
      outputQualityDelta: cuppet.meanExpectedCoverage - baseline.meanExpectedCoverage,
      toolCallDelta: cuppet.meanToolCalls - baseline.meanToolCalls,
      totalCostDelta: cuppet.totalCost - baseline.totalCost,
    },
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle] ?? 0
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function totalModelTokens(usage: TokenUsage): number {
  return usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite
}

function isGraphTool(name: string): boolean {
  return name === 'cuppet_workspace_info'
    || name === 'cuppet_graph_tree'
    || name === 'cuppet_graph_search'
    || name === 'cuppet_graph_trace'
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
