import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
const selectedTasks = tasks.slice(0, taskLimit)

const project = resolve(process.cwd())
const base = await mkdtemp(join(tmpdir(), 'cuppet-ab-'))
const paths = await createRuntimePaths(project, base)
const logger = new RedactedLogger(paths.logs)
const assets = await resolveRuntimeAssets()
if (!assets.opencode || !assets.tst) throw new Error(`Evaluation runtimes unavailable: ${assets.diagnostics.join('; ')}`)

const globalPreferences = new PreferenceStore(join(process.env.HOME ?? '', '.cuppet', 'v2', 'preferences.json'))
await globalPreferences.load()
const configuredModel = globalPreferences.value.primary
const model = parseModel(process.env.CUPPET_AB_MODEL) ?? configuredModel ?? {
  providerID: 'google-vertex',
  modelID: 'gemini-flash-latest',
}

let tst: TstRuntime | undefined
let opencode: OpenCodeRuntime | undefined
let gateway: OpenCodeGateway | undefined
const trials: Trial[] = []

try {
  tst = await startTstDaemon(assets.tst, paths, logger)
  opencode = await startOpenCodeServer({
    binary: assets.opencode,
    paths,
    logger,
    ...(assets.plugin ? { plugin: assets.plugin } : {}),
    tst: { socket: tst.socket, token: tst.token },
    ...(globalPreferences.value.vertexProject ? { vertexProject: globalPreferences.value.vertexProject } : {}),
  })
  gateway = new OpenCodeGateway(opencode.client, project)
  const pending = new Set<string>()
  const errors = new Map<string, string>()
  gateway.onEvent((event) => {
    if (event.type === 'permission' && !pending.has(event.request.id)) {
      pending.add(event.request.id)
      // Evaluation tasks are read-only. Reject any unexpected mutation/shell request identically.
      void gateway?.replyPermission(event.request.sessionID, event.request.id, 'reject')
    }
    if (event.type === 'error' && event.sessionID) errors.set(event.sessionID, event.message)
  })
  gateway.startEvents()
  await waitForIndex(tst)

  for (let index = 0; index < selectedTasks.length; index += 1) {
    const task = selectedTasks[index]!
    const order: Arm[] = index % 2 === 0 ? ['opencode', 'cuppet'] : ['cuppet', 'opencode']
    for (const arm of order) {
      process.stdout.write(`[${index + 1}/${selectedTasks.length}] ${task.id} · ${arm}\n`)
      const session = await gateway.createSession(model)
      const enriched = arm === 'cuppet'
        ? await buildCuppetContext(tst.client, session.id, task.prompt, 1_048_576, [], '', project)
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
      trials.push({
        task: task.id,
        arm,
        sessionID: session.id,
        success: !failure && !eventError && task.expected.every((item) => normalizedAnswer.includes(item.toLowerCase())),
        expected: task.expected,
        answer,
        durationMs: Math.round(performance.now() - started),
        contextTokens: enriched.contextTokens,
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
    design: 'paired fresh sessions; shared OpenCode server/kernel; identical read-only tools and permissions; alternating arm order',
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

function parseModel(value: string | undefined): ModelRef | undefined {
  if (!value) return undefined
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) throw new Error('CUPPET_AB_MODEL must be provider/model')
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
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
      medianCostDeltaPerSuccess: cuppet.medianCostPerSuccess - baseline.medianCostPerSuccess,
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
