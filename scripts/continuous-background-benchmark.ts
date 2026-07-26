import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { CuppetController } from '../packages/cli/src/controller.js'
import { PreferenceStore } from '../packages/cli/src/config/preferences.js'
import { OpenCodeGateway } from '../packages/cli/src/opencode/gateway.js'
import { startOpenCodeServer, type OpenCodeRuntime } from '../packages/cli/src/opencode/server.js'
import { resolveRuntimeAssets } from '../packages/cli/src/runtime/assets.js'
import { RedactedLogger } from '../packages/cli/src/runtime/logger.js'
import { createRuntimePaths } from '../packages/cli/src/runtime/paths.js'
import { startTstDaemon, type TstRuntime } from '../packages/cli/src/tst/supervisor.js'
import type { BackgroundStats } from '../packages/cli/src/background/worker.js'
import type { ModelRef, TokenUsage } from '../packages/cli/src/types.js'
import { totalTokenUsage } from '../packages/cli/src/usage.js'

type Task = { id: string; prompt: string; expected: string[] }

type Turn = {
  id: string
  correct: boolean
  durationMs: number
  foregroundUsage: TokenUsage
  backgroundRunningAtStart: boolean
}

type Scenario = {
  name: 'paused' | 'active'
  foregroundUsage: TokenUsage
  foregroundCost: number
  backgroundInitialization: BackgroundStats | undefined
  backgroundFinal: BackgroundStats | undefined
  turns: Turn[]
  overlapTurns: number
  deferredAfterForeground: number
}

const tasks: Task[] = [
  {
    id: 'context-builder',
    prompt: 'Read-only code navigation task. Identify the source file and function that construct the CUPPET_CONTEXT block. Answer with only: <path> :: <function>. Do not modify files.',
    expected: ['packages/cli/src/tst/context.ts', 'buildCuppetContext'],
  },
  {
    id: 'allocator',
    prompt: 'Continue the read-only navigation task. Identify the source file and function that allocate characters among Cuppet context sections. Answer with only: <path> :: <function>. Do not modify files.',
    expected: ['packages/cli/src/tst/context.ts', 'allocateCharacters'],
  },
  {
    id: 'graph-renderer',
    prompt: 'Continue the read-only navigation task. Identify the source file and function that render graph records into the Cuppet context block. Run exactly `npm run typecheck` as a validation command after identifying it. Answer with only: <path> :: <function>. Do not modify files.',
    expected: ['packages/cli/src/tst/context.ts', 'renderGraph'],
  },
]

const project = resolve(process.cwd())
const globalPreferences = new PreferenceStore(join(process.env.HOME ?? '', '.cuppet', 'v2', 'preferences.json'))
await globalPreferences.load()
const primary = globalPreferences.value.primary
const secondary = globalPreferences.value.secondary
if (!primary || !secondary || primary.providerID !== 'openai' || secondary.providerID !== 'openai') {
  throw new Error('This benchmark requires configured OpenAI primary and secondary models')
}

const assets = await resolveRuntimeAssets()
if (!assets.opencode || !assets.tst || !assets.plugin) {
  throw new Error(`Evaluation runtimes unavailable: ${assets.diagnostics.join('; ')}`)
}

const paused = await runScenario('paused', primary, secondary)
const active = await runScenario('active', primary, secondary)
const report = {
  schema: 1,
  createdAt: new Date().toISOString(),
  primary,
  secondary,
  design: 'Two isolated three-turn foreground sessions use the same selected models and read-only prompts. Only a successful validation produces a merged pending batch. The active arm waits through the real foreground-idle window after all turns, so no foreground turn may overlap secondary-model work. Background usage is measured independently from foreground session usage.',
  scenarios: { paused, active },
  comparison: summarize(paused, active),
}

const resultsDirectory = join(project, 'benchmarks', 'results')
await mkdir(resultsDirectory, { recursive: true })
const stamp = new Date().toISOString().replaceAll(':', '-')
const jsonPath = join(resultsDirectory, `continuous-background-${stamp}.json`)
const markdownPath = join(resultsDirectory, `continuous-background-${stamp}.md`)
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
await writeFile(markdownPath, `${renderMarkdown(report)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(report.comparison, null, 2)}\nRaw result: ${jsonPath}\nSummary: ${markdownPath}\n`)

async function runScenario(name: Scenario['name'], primaryModel: ModelRef, secondaryModel: ModelRef): Promise<Scenario> {
  const root = await mkdtemp(join('/private/tmp', `cuppet-background-${name}-`))
  let tst: TstRuntime | undefined
  let opencode: OpenCodeRuntime | undefined
  let controller: CuppetController | undefined
  let unsubscribePermissions: (() => void) | undefined
  try {
    const paths = await createRuntimePaths(project, root)
    await seedOpenCodeProviderState(paths)
    const preferences = new PreferenceStore(paths.preferences)
    await preferences.update({
      platform: 'openai',
      primary: primaryModel,
      secondary: secondaryModel,
      backgroundPaused: name === 'paused',
    })
    const logger = new RedactedLogger(paths.logs)
    tst = await startTstDaemon(assets.tst!, paths, logger)
    await waitForIndex(tst)
    opencode = await startOpenCodeServer({
      binary: assets.opencode!,
      paths,
      logger,
      plugin: assets.plugin,
      tst: { socket: tst.socket, token: tst.token },
    })
    const gateway = new OpenCodeGateway(opencode.client, project)
    controller = new CuppetController({
      gateway,
      tst: tst.client,
      preferences,
      paths,
      assets,
      vertex: opencode.vertex,
      interactive: true,
    })
    await controller.initialize()
    unsubscribePermissions = gateway.onEvent((event) => {
      if (event.type !== 'permission') return
      const command = event.request.resources.join('\n')
      const allow = event.request.action === 'bash' && /npm\s+run\s+typecheck/.test(command)
      void gateway.replyPermission(event.request.sessionID, event.request.id, allow ? 'once' : 'reject')
    })
    const backgroundInitialization = cloneBackground(controller.snapshot.background)
    const turns: Turn[] = []
    let overlapTurns = 0
    let previousForeground = controller.snapshot.foregroundUsage

    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index]!
      const backgroundRunningAtStart = Boolean(controller.snapshot.background?.running)
      if (backgroundRunningAtStart) overlapTurns += 1
      const started = performance.now()
      const answer = await controller.submitAndWait(task.prompt)
      const currentForeground = controller.snapshot.foregroundUsage
      turns.push({
        id: task.id,
        correct: task.expected.every((item) => answer.toLowerCase().includes(item.toLowerCase())),
        durationMs: Math.round(performance.now() - started),
        foregroundUsage: difference(currentForeground, previousForeground),
        backgroundRunningAtStart,
      })
      previousForeground = currentForeground
    }

    const deferredAfterForeground = await waitForDeferredBatch(controller)
    if (name === 'active') await waitForBackgroundSettled(controller)
    const snapshot = controller.snapshot
    return {
      name,
      foregroundUsage: snapshot.foregroundUsage,
      foregroundCost: snapshot.foregroundCost,
      backgroundInitialization,
      backgroundFinal: cloneBackground(snapshot.background),
      turns,
      overlapTurns,
      deferredAfterForeground,
    }
  } finally {
    unsubscribePermissions?.()
    await controller?.close().catch(() => undefined)
    await opencode?.close().catch(() => undefined)
    await tst?.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
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

async function waitForIndex(runtime: TstRuntime): Promise<void> {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const status = await runtime.client.call<{ graph?: { progress?: { complete?: boolean } } }>('status')
    if (status.graph?.progress?.complete) return
    await delay(50)
  }
  throw new Error('graph indexing timed out')
}

async function waitForBackgroundSettled(controller: CuppetController): Promise<void> {
  const deadline = Date.now() + 180_000
  let stableSince = 0
  while (Date.now() < deadline) {
    const background = controller.snapshot.background
    if (background && !background.running && background.queued === 0) {
      if (stableSince === 0) stableSince = Date.now()
      if (Date.now() - stableSince >= 250) return
    } else {
      stableSince = 0
    }
    await delay(50)
  }
  throw new Error('background worker did not settle')
}

async function waitForDeferredBatch(controller: CuppetController): Promise<number> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const background = controller.snapshot.background
    if (background && background.deferred > 0) return background.deferred
    await delay(25)
  }
  throw new Error('continuous benchmark did not produce a deferred background batch')
}

function cloneBackground(background: BackgroundStats | undefined): BackgroundStats | undefined {
  return background && {
    ...background,
    usage: { ...background.usage },
  }
}

function difference(after: TokenUsage, before: TokenUsage): TokenUsage {
  return {
    input: Math.max(0, after.input - before.input),
    output: Math.max(0, after.output - before.output),
    reasoning: Math.max(0, after.reasoning - before.reasoning),
    cacheRead: Math.max(0, after.cacheRead - before.cacheRead),
    cacheWrite: Math.max(0, after.cacheWrite - before.cacheWrite),
  }
}

function usageDelta(after: TokenUsage | undefined, before: TokenUsage | undefined): TokenUsage {
  return difference(after ?? emptyUsage(), before ?? emptyUsage())
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

function summarize(paused: Scenario, active: Scenario) {
  const activeInitializationUsage = active.backgroundInitialization?.usage ?? emptyUsage()
  const activeContinuousUsage = usageDelta(active.backgroundFinal?.usage, activeInitializationUsage)
  const pausedTotal = totalTokenUsage(paused.foregroundUsage)
  const activeForeground = totalTokenUsage(active.foregroundUsage)
  const activeBackground = totalTokenUsage(active.backgroundFinal?.usage ?? emptyUsage())
  return {
    paused: {
      foregroundTokens: pausedTotal,
      backgroundTokens: totalTokenUsage(paused.backgroundFinal?.usage ?? emptyUsage()),
      correctTurns: paused.turns.filter((turn) => turn.correct).length,
    },
    active: {
      foregroundTokens: activeForeground,
      backgroundTokens: activeBackground,
      totalTokens: activeForeground + activeBackground,
      initializationBackgroundTokens: totalTokenUsage(activeInitializationUsage),
      continuousBackgroundTokens: totalTokenUsage(activeContinuousUsage),
      completedBackgroundJobs: active.backgroundFinal?.completed ?? 0,
      failedBackgroundJobs: active.backgroundFinal?.failed ?? 0,
      overlapTurns: active.overlapTurns,
      deferredAfterForeground: active.deferredAfterForeground,
      correctTurns: active.turns.filter((turn) => turn.correct).length,
    },
    totalTokenIncreaseVsPaused: activeForeground + activeBackground - pausedTotal,
    compactBatchReductionVsThreeLegacyTurnJobs: 1 - ratio(active.backgroundFinal?.completed ?? 0, 3),
    gates: {
      oneDeferredBatch: active.deferredAfterForeground === 1,
      zeroForegroundOverlap: active.overlapTurns === 0,
      atLeastFiftyPercentFewerBackgroundBatches: (1 - ratio(active.backgroundFinal?.completed ?? 0, 3)) >= 0.5,
    },
  }
}

function renderMarkdown(report: {
  createdAt: string
  primary: ModelRef
  secondary: ModelRef
  scenarios: { paused: Scenario; active: Scenario }
  comparison: ReturnType<typeof summarize>
}): string {
  const paused = report.scenarios.paused
  const active = report.scenarios.active
  const comparison = report.comparison
  return [
    '# Continuous background-worker token benchmark',
    '',
    `- Created: ${report.createdAt}`,
    `- Foreground model: \`${formatModel(report.primary)}\`; background model: \`${formatModel(report.secondary)}\`.`,
    '- Both arms use the same three foreground turns. The active arm waits through the real foreground-idle window after the final turn; background work is not intentionally overlapped with a foreground request.',
    '',
    '## Results',
    '',
    '| Metric | Background paused | Background active |',
    '|---|---:|---:|',
    `| Correct foreground turns | ${comparison.paused.correctTurns}/3 | ${comparison.active.correctTurns}/3 |`,
    `| Foreground model tokens | ${comparison.paused.foregroundTokens} | ${comparison.active.foregroundTokens} |`,
    `| Background model tokens | ${comparison.paused.backgroundTokens} | ${comparison.active.backgroundTokens} |`,
    `| Active total model tokens | ${comparison.paused.foregroundTokens} | ${comparison.active.totalTokens} |`,
    `| Active initialization background tokens | — | ${comparison.active.initializationBackgroundTokens} |`,
    `| Active continuous background tokens | — | ${comparison.active.continuousBackgroundTokens} |`,
    `| Completed / failed background jobs | — | ${comparison.active.completedBackgroundJobs} / ${comparison.active.failedBackgroundJobs} |`,
    `| Deferred batches after foreground | — | ${comparison.active.deferredAfterForeground} |`,
    `| Foreground turns overlapping a running background job | 0 | ${comparison.active.overlapTurns} |`,
    '',
    `Total model-token increase with background active: ${comparison.totalTokenIncreaseVsPaused}. Reported provider costs are retained in the raw JSON; zero-valued telemetry is not treated as free usage.`,
    `Gates: one deferred batch ${comparison.gates.oneDeferredBatch ? 'passed' : 'failed'}; zero foreground overlap ${comparison.gates.zeroForegroundOverlap ? 'passed' : 'failed'}; batch-count reduction versus three legacy per-turn jobs ${comparison.gates.atLeastFiftyPercentFewerBackgroundBatches ? 'passed' : 'failed'}.`,
    '',
    '## Per-turn foreground usage',
    '',
    ...['paused', 'active'].flatMap((name) => {
      const scenario = name === 'paused' ? paused : active
      return scenario.turns.map((turn) =>
        `- ${name}/${turn.id}: ${turn.correct ? 'correct' : 'incorrect'}; ${totalTokenUsage(turn.foregroundUsage)} foreground tokens; ${turn.durationMs} ms; background running at start: ${turn.backgroundRunningAtStart ? 'yes' : 'no'}.`,
      )
    }),
  ].join('\n')
}

function formatModel(model: ModelRef): string {
  return `${model.providerID}/${model.modelID}${model.variant ? `@${model.variant}` : ''}`
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}
