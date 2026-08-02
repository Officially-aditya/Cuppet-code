import { createHash, randomBytes } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { PreferenceStore } from '../packages/cli/src/config/preferences.js'
import { OpenCodeGateway } from '../packages/cli/src/opencode/gateway.js'
import { startOpenCodeServer, type OpenCodeRuntime } from '../packages/cli/src/opencode/server.js'
import { resolveRuntimeAssets } from '../packages/cli/src/runtime/assets.js'
import { RedactedLogger } from '../packages/cli/src/runtime/logger.js'
import { createRuntimePaths } from '../packages/cli/src/runtime/paths.js'
import { startTstDaemon, type TstRuntime } from '../packages/cli/src/tst/supervisor.js'
import type { AgentEvent, ModelRef, TokenUsage } from '../packages/cli/src/types.js'
import { completedPairKeys, trialPairKey, validateCompletedPairs } from '../packages/cli/src/benchmark/ab-stm-compaction-recovery.js'

const SCHEMA = 1 as const
const EXPERIMENT = 'ab-stm-compaction'
const DEFAULT_REPEATS = 5
const MAX_REPEATS = 5
const PHASES = [
  'Inspect the fixture and trace the overlapping dependency paths. The requested refactor is to rename Task.title to Task.name everywhere. Do not edit yet. Report the files and constraints you will preserve.',
  'Rename Task.title to Task.name everywhere in the fixture. Keep src/unrelated.ts unchanged, preserve the public API, and update every overlapping caller and test fixture.',
  'Review the complete change, run the fixture validation command if available, and correct any missed references or regressions.',
] as const
const EXPECTED_ANCHORS = ['src/model.ts', 'src/store.ts', 'src/api.ts', 'src/display.ts']
const EXPECTED_CONSTRAINTS = ['src/unrelated.ts', 'public API', 'every overlapping caller']

const FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'stm-compaction-fixture',
    private: true,
    type: 'module',
    scripts: { validate: 'node --input-type=module -e "process.exit(0)"' },
  }, null, 2) + '\n',
  'src/model.ts': `export type Task = { id: string; title: string; done: boolean }\n\nexport function makeTask(id: string, title: string): Task {\n  return { id, title, done: false }\n}\n`,
  'src/store.ts': `import type { Task } from './model.ts'\n\nconst tasks = new Map<string, Task>()\n\nexport function saveTask(task: Task): Task {\n  tasks.set(task.id, task)\n  return task\n}\n\nexport function getTask(id: string): Task | undefined {\n  return tasks.get(id)\n}\n`,
  'src/api.ts': `import { makeTask } from './model.ts'\nimport { saveTask } from './store.ts'\n\nexport function createTask(title: string) {\n  return saveTask(makeTask('task-1', title))\n}\n\nexport function taskTitle(id: string) {\n  return id\n}\n`,
  'src/display.ts': `import type { Task } from './model.ts'\n\nexport function displayTask(task: Task): string {\n  return task.done ? '[x] ' + task.title : '[ ] ' + task.title\n}\n`,
  'src/unrelated.ts': `export const unrelatedMarker = 'leave this file unchanged'\nexport function unrelated(value: string): string { return value.toUpperCase() }\n`,
  'test/fixture.test.ts': `import assert from 'node:assert/strict'\nimport { createTask } from '../src/api.ts'\nimport { displayTask } from '../src/display.ts'\n\nconst task = createTask('demo')\nassert.equal(task.title, 'demo')\nassert.equal(displayTask(task), '[ ] demo')\n`,
}

type Arm = 'control' | 'stm_only'

type ExperimentConfig = {
  experiment: typeof EXPERIMENT
  repeats: number
  model: ModelRef
  fixtureHash: string
  patchSetDigest: string
  armOrders: Arm[][]
  phases: number
}

type Trial = {
  repeat: number
  arm: Arm
  workspace: string
  runtimeRoot: string
  sessionID: string
  success: boolean
  correctness: {
    passed: boolean
    checks: Record<string, boolean>
    hiddenTests: Record<string, boolean>
  }
  retainedFilePrecision: number
  retainedFileRecall: number
  constraintRecall: number
  stmSize: number
  injectedTokens: number
  compactionTokens: number
  totalInputTokens: number
  latencyMs: number
  cost: number
  usage: TokenUsage
  compactions: number
  stmRefreshes: number
  failures: string[]
  telemetry: Record<string, unknown>
  error?: string
  finishedAt: string
}

type ActiveTrial = {
  repeat: number
  arm: Arm
  workspace: string
  runtimeRoot: string
  sessionID?: string
  stage: string
  promptPhase?: number
  compaction?: number
  startedAt: string
  heartbeatAt: string
  telemetry: Record<string, unknown>
}

type Checkpoint = {
  schema: typeof SCHEMA
  runID: string
  createdAt: string
  updatedAt: string
  config: ExperimentConfig
  paths: {
    root: string
    checkpoint: string
    eventLog: string
    partialJson: string
    partialMarkdown: string
  }
  completedTrials: Trial[]
  activeTrial?: ActiveTrial
  telemetry: Record<string, unknown>
  lastEvent: string
  heartbeatAt: string
  error?: { message: string; stack?: string; signal?: string }
}

type Prepared = {
  stm?: Array<{ key?: string; value?: string; file_hashes?: Record<string, string> }>
  paths?: string[]
}

type BenchmarkState = {
  checkpoint: Checkpoint
  reportWritten: boolean
}

const project = resolve(process.cwd())
const resultsDirectory = resolve(project, 'benchmarks', 'results')
const repeats = parseRepeats(process.env.CUPPET_STM_COMPACTION_REPEATS)
const keepArtifacts = process.env.CUPPET_STM_COMPACTION_KEEP_ARTIFACTS === '1'
const resumeInput = process.env.CUPPET_STM_COMPACTION_RESUME
const resumePath = resumeInput
  ? resolve(resumeInput)
  : undefined
let signalCheckpoint: (() => Promise<void>) | undefined
let signalHandled = false
let persistenceTail = Promise.resolve()

process.once('SIGINT', () => {
  signalHandled = true
  void (signalCheckpoint?.() ?? Promise.resolve()).finally(() => process.exit(130))
})
process.once('SIGTERM', () => {
  signalHandled = true
  void (signalCheckpoint?.() ?? Promise.resolve()).finally(() => process.exit(143))
})

async function main(): Promise<void> {
  if (resumeInput && !isAbsolute(resumeInput)) throw new Error('CUPPET_STM_COMPACTION_RESUME must be absolute')
  await mkdir(resultsDirectory, { recursive: true, mode: 0o700 })
  const fixtureHash = hashFixture()
  const patchSetDigest = await hashPatchSet()
  const preferences = new PreferenceStore(join(homedir(), '.cuppet', 'v2', 'preferences.json'))
  await preferences.load()
  const configuredModel = parseModel(process.env.CUPPET_AB_MODEL, process.env.CUPPET_AB_VARIANT)
  const model = configuredModel ?? preferences.value.primary ?? {
    providerID: 'google-vertex',
    modelID: 'gemini-flash-latest',
  }
  const config: ExperimentConfig = {
    experiment: EXPERIMENT,
    repeats,
    model,
    fixtureHash,
    patchSetDigest,
    armOrders: Array.from({ length: repeats }, (_, repeat) => repeat % 2 === 0
      ? ['control', 'stm_only']
      : ['stm_only', 'control']),
    phases: PHASES.length,
  }
  const state = await loadOrCreateState(config)
  activeRoot = state.checkpoint.paths.root
  signalCheckpoint = async () => {
    await persist(state, signalHandled ? 'signal' : 'process_error', {
      error: {
        message: signalHandled ? 'benchmark interrupted by process signal' : 'benchmark process error',
        ...(signalHandled ? { signal: 'SIGINT/SIGTERM' } : {}),
      },
    })
  }

  try {
    const assets = await resolveRuntimeAssets()
    if (!assets.opencode || !assets.tst || !assets.plugin) {
      throw new Error(`Experiment runtimes unavailable: ${assets.diagnostics.join('; ')}`)
    }
    const completedPairs = completedPairKeys(state.checkpoint.completedTrials)
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      for (const arm of config.armOrders[repeat]!) {
        if (completedPairs.has(trialPairKey(repeat + 1, arm))) {
          await persist(state, `arm.${repeat + 1}.${arm}.skipped`, { detail: 'completed trial retained from checkpoint' })
          continue
        }
        const trial = await runArm({
          state,
          assets: { opencode: assets.opencode!, tst: assets.tst!, plugin: assets.plugin! },
          model,
          repeat,
          arm,
        })
        state.checkpoint.completedTrials.push(trial)
        completedPairs.add(trialPairKey(repeat + 1, arm))
        delete state.checkpoint.activeTrial
        await persist(state, `arm.${repeat + 1}.${arm}.finished`, { trial })
        await writePartialReport(state, config)
      }
    }

    const report = buildReport(state.checkpoint, config)
    const finalJson = join(resultsDirectory, `${state.checkpoint.runID}.json`)
    const finalMarkdown = join(resultsDirectory, `${state.checkpoint.runID}.md`)
    await writeAtomic(finalJson, `${JSON.stringify(report, null, 2)}\n`)
    await writeAtomic(finalMarkdown, renderMarkdown(report))
    state.reportWritten = true
    await persist(state, 'report.finished', { report: finalJson })
    process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\nRaw result: ${finalJson}\nSummary: ${finalMarkdown}\n`)
  } catch (error) {
    await persist(state, 'process.error', { error: serializeError(error) }).catch(() => undefined)
    throw error
  } finally {
    // Checkpoint and event log are deliberately outside root and remain for
    // auditability. Workspaces/stores are removable only after final report
    // writes have completed successfully.
    if (state.reportWritten && !keepArtifacts) {
      await rm(state.checkpoint.paths.root, { recursive: true, force: true }).catch(() => undefined)
    } else if (!state.reportWritten) {
      process.stderr.write(`Benchmark interrupted; artifacts retained at ${state.checkpoint.paths.root}\n`)
    }
  }
}

async function runArm(options: {
  state: BenchmarkState
  assets: { opencode: string; tst: string; plugin: string }
  model: ModelRef
  repeat: number
  arm: Arm
}): Promise<Trial> {
  const { state, assets, model, repeat, arm } = options
  const root = state.checkpoint.paths.root
  const workspace = join(root, 'workspaces', `${arm}-${repeat + 1}`)
  const runtimeRoot = join(root, 'runtimes', `${arm}-${repeat + 1}`)
  await cloneFixture(workspace)
  await rm(runtimeRoot, { recursive: true, force: true })
  const paths = await createRuntimePaths(workspace, runtimeRoot)
  const active: ActiveTrial = {
    repeat: repeat + 1,
    arm,
    workspace,
    runtimeRoot,
    stage: 'runtime_created',
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    telemetry: {},
  }
  state.checkpoint.activeTrial = active
    await persist(state, `arm.${repeat + 1}.${arm}.runtime_created`, { activeTrial: active })

    const previousFlag = process.env.CUPPET_STM_ONLY_COMPACTION
  if (arm === 'stm_only') process.env.CUPPET_STM_ONLY_COMPACTION = '1'
  else delete process.env.CUPPET_STM_ONLY_COMPACTION
  const logger = new RedactedLogger(paths.logs)
  let tst: TstRuntime | undefined
  let opencode: OpenCodeRuntime | undefined
  let gateway: OpenCodeGateway | undefined
  const failures: string[] = []
  const telemetry: Record<string, unknown> = {
    arm,
    repeat: repeat + 1,
    phases: [],
    compactionEvents: [],
    stmRefreshEvents: [],
  }
  const started = performance.now()
  let sessionID = ''
  let compactions = 0
  let stmRefreshes = 0
  let injectedTokens = 0
  let compactionTokens = 0
  let lastSessionTokens: TokenUsage = zeroUsage()
  let lastSessionCost = 0
  let refreshWaiter: (() => void) | undefined

  try {
    await seedOpenCodeProviderState(paths)
    tst = await startTstDaemon(assets.tst, paths, logger)
    tst.client.onNotification((notification) => {
      if (notification.method === 'stm.refreshed') {
        stmRefreshes += 1
        const events = (telemetry.stmRefreshEvents as unknown[] | undefined) ?? []
        events.push({ at: new Date().toISOString(), params: notification.params })
        telemetry.stmRefreshEvents = events
        refreshWaiter?.()
        refreshWaiter = undefined
        void persist(state, `arm.${repeat + 1}.${arm}.stm_refresh_completed`, {
          stmRefreshes,
          params: notification.params,
        })
      }
    })
    await waitForIndex(tst)
    await persist(state, `arm.${repeat + 1}.${arm}.tst_created`, { runtimeRoot, stores: [paths.projectStore, paths.globalStore] })
    opencode = await startOpenCodeServer({
      binary: assets.opencode,
      paths,
      logger,
      plugin: assets.plugin,
      tst: { socket: tst.socket, token: tst.token },
    })
    await persist(state, `arm.${repeat + 1}.${arm}.opencode_created`, { runtimeRoot })
    gateway = new OpenCodeGateway(opencode.client, workspace)
    const pendingPermissions = new Set<string>()
    const allowedPermissions = new Set([
      'read',
      'edit',
      'write',
      'bash',
      'glob',
      'grep',
      'lsp',
      'question',
      'todowrite',
      'task',
      'cuppet_memory_search',
      'cuppet_workspace_info',
      'cuppet_graph_tree',
      'cuppet_graph_search',
      'cuppet_graph_trace',
    ])
    gateway.onEvent((event: AgentEvent) => {
      if (event.type === 'permission' && !pendingPermissions.has(event.request.id)) {
        pendingPermissions.add(event.request.id)
        const reply = event.request.action === 'external_directory' || !allowedPermissions.has(event.request.action)
          ? 'reject'
          : 'once'
        void gateway?.replyPermission(event.request.sessionID, event.request.id, reply)
          .catch((error) => logger.write('warn', `benchmark permission reply failed: ${errorMessage(error)}`))
      }
      if (event.type === 'error') failures.push(event.message)
      if (event.type === 'compaction') {
        const events = (telemetry.compactionEvents as unknown[] | undefined) ?? []
        events.push({ phase: event.phase, at: new Date().toISOString() })
        telemetry.compactionEvents = events
      }
    })
    gateway.startEvents()
    const session = await gateway.createSession(model)
    sessionID = session.id
    active.sessionID = sessionID
    active.stage = 'session_created'
    await persist(state, `arm.${repeat + 1}.${arm}.session_created`, { sessionID })

    for (let phase = 0; phase < PHASES.length; phase += 1) {
      active.stage = 'prompt_phase'
      active.promptPhase = phase + 1
      await runPromptPhase(gateway, sessionID, PHASES[phase], phase, telemetry)
      const current = await gateway.getSession(sessionID)
      lastSessionTokens = current.tokens
      lastSessionCost = current.cost
      injectedTokens += await syntheticTokenCount(gateway, sessionID)
      const phases = telemetry.phases as unknown[]
      phases.push({ phase: phase + 1, at: new Date().toISOString(), tokens: current.tokens, cost: current.cost })
      await persist(state, `arm.${repeat + 1}.${arm}.prompt_phase_${phase + 1}`, { phase: phase + 1, tokens: current.tokens })

      if (phase < 2) {
        const compactionNumber = phase + 1
        active.stage = 'compaction_start'
        active.compaction = compactionNumber
        await persist(state, `arm.${repeat + 1}.${arm}.compaction_${compactionNumber}.start`, { sessionID })
        const before = await gateway.getSession(sessionID)
        const compactionStarted = performance.now()
        const refreshPromise = arm === 'stm_only'
          ? new Promise<void>((resolvePromise) => {
              refreshWaiter = resolvePromise
            })
          : undefined
        await gateway.compact(sessionID)
        await withTimeout(gateway.wait(sessionID), 10 * 60_000, `${arm} compaction ${compactionNumber} timed out`)
        const after = await gateway.getSession(sessionID)
        compactions += 1
        compactionTokens += Math.max(0, after.tokens.input - before.tokens.input)
        const compactionDetail = {
          number: compactionNumber,
          durationMs: Math.round(performance.now() - compactionStarted),
          before: before.tokens,
          after: after.tokens,
        }
        await persist(state, `arm.${repeat + 1}.${arm}.compaction_${compactionNumber}.completed`, compactionDetail)
        if (refreshPromise) await waitForRefresh(() => refreshPromise, 2_500)
          .catch((error) => failures.push(`STM refresh notification: ${errorMessage(error)}`))
      }
    }

    const current = await gateway.getSession(sessionID)
    lastSessionTokens = current.tokens
    lastSessionCost = current.cost
    const prepared = await tst.client.call<Prepared>('context.prepare', {
      session_id: sessionID,
      query: 'src/model.ts src/store.ts src/api.ts src/display.ts preserve public API do not modify src/unrelated.ts',
      mode: 'stm_only',
      observations: [],
    })
    const retainedPaths = prepared.paths ?? []
    const retainedRecords = prepared.stm ?? []
    const retention = retentionMetrics(retainedPaths, retainedRecords)
    const correctness = await evaluateFixture(workspace)
    const failureList = [...new Set(failures.filter(Boolean))]
    const trial: Trial = {
      repeat: repeat + 1,
      arm,
      workspace,
      runtimeRoot,
      sessionID,
      success: correctness.passed && failureList.length === 0,
      correctness,
      retainedFilePrecision: retention.precision,
      retainedFileRecall: retention.recall,
      constraintRecall: retention.constraintRecall,
      stmSize: retainedRecords.length,
      injectedTokens,
      compactionTokens,
      totalInputTokens: lastSessionTokens.input,
      latencyMs: Math.round(performance.now() - started),
      cost: lastSessionCost,
      usage: lastSessionTokens,
      compactions,
      stmRefreshes,
      failures: failureList,
      telemetry: {
        ...telemetry,
        retentionPaths: retainedPaths,
        retentionRecords: retainedRecords.map((record) => ({ key: record.key, value: record.value })),
      },
      finishedAt: new Date().toISOString(),
    }
    active.stage = 'arm_finished'
    active.telemetry = { ...telemetry, lastSessionTokens, lastSessionCost }
    return trial
  } catch (error) {
    const failure = errorMessage(error)
    failures.push(failure)
    await persist(state, `arm.${repeat + 1}.${arm}.error`, { error: serializeError(error) }).catch(() => undefined)
    return {
      repeat: repeat + 1,
      arm,
      workspace,
      runtimeRoot,
      sessionID,
      success: false,
      correctness: { passed: false, checks: {}, hiddenTests: {} },
      retainedFilePrecision: 0,
      retainedFileRecall: 0,
      constraintRecall: 0,
      stmSize: 0,
      injectedTokens,
      compactionTokens,
      totalInputTokens: lastSessionTokens.input,
      latencyMs: Math.round(performance.now() - started),
      cost: lastSessionCost,
      usage: lastSessionTokens,
      compactions,
      stmRefreshes,
      failures: [...new Set(failures)],
      telemetry,
      error: failure,
      finishedAt: new Date().toISOString(),
    }
  } finally {
    await gateway?.close().catch(() => undefined)
    await opencode?.close().catch(() => undefined)
    await tst?.close().catch(() => undefined)
    if (previousFlag === undefined) delete process.env.CUPPET_STM_ONLY_COMPACTION
    else process.env.CUPPET_STM_ONLY_COMPACTION = previousFlag
  }
}

async function runPromptPhase(
  gateway: OpenCodeGateway,
  sessionID: string,
  prompt: string,
  phase: number,
  telemetry: Record<string, unknown>,
): Promise<void> {
  const started = performance.now()
  await gateway.prompt(sessionID, `${prompt}\n\nExperiment phase ${phase + 1} of ${PHASES.length}.`)
  await withTimeout(gateway.wait(sessionID), 10 * 60_000, `prompt phase ${phase + 1} timed out`)
  const phases = telemetry.phases as unknown[] | undefined
  if (phases) phases.push({ phase: phase + 1, promptMs: Math.round(performance.now() - started) })
}

async function waitForRefresh(factory: () => Promise<void>, timeoutMs: number): Promise<void> {
  await Promise.race([
    factory(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('STM refresh notification timed out')), timeoutMs)),
  ])
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, detail: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(detail)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function retentionMetrics(paths: string[], records: Array<{ key?: string; value?: string }>): {
  precision: number
  recall: number
  constraintRecall: number
} {
  const normalized = [...new Set(paths.map(normalizeFixturePath))]
  const found = EXPECTED_ANCHORS.filter((path) => normalized.includes(path))
  const precision = normalized.length === 0 ? 0 : found.length / normalized.length
  const recall = found.length / EXPECTED_ANCHORS.length
  const text = records.map((record) => `${record.key ?? ''} ${record.value ?? ''}`).join(' ').toLowerCase()
  const constraints = EXPECTED_CONSTRAINTS.filter((constraint) => text.includes(constraint.toLowerCase()))
  return { precision, recall, constraintRecall: constraints.length / EXPECTED_CONSTRAINTS.length }
}

async function evaluateFixture(workspace: string): Promise<Trial['correctness']> {
  const source = new Map<string, string>()
  for (const path of Object.keys(FIXTURE)) {
    if (!path.endsWith('.ts')) continue
    source.set(path, await readFile(join(workspace, path), 'utf8').catch(() => ''))
  }
  const model = source.get('src/model.ts') ?? ''
  const store = source.get('src/store.ts') ?? ''
  const api = source.get('src/api.ts') ?? ''
  const display = source.get('src/display.ts') ?? ''
  const test = source.get('test/fixture.test.ts') ?? ''
  const unrelated = source.get('src/unrelated.ts') ?? ''
  const originalUnrelated = FIXTURE['src/unrelated.ts']!
  const checks = {
    modelUsesName: /\bname\b/.test(model) && !/\btitle\b/.test(model),
    storePreservesBoundary: /\bsaveTask\b/.test(store) && /\bgetTask\b/.test(store) && !/\btitle\b/.test(store),
    apiUsesName: /\bname\b/.test(api) && !/\btitle\b/.test(api),
    displayUsesName: /\bname\b/.test(display) && !/\btitle\b/.test(display),
    testsUseName: /\bname\b/.test(test) && !/\btitle\b/.test(test),
  }
  const hiddenTests = {
    unrelatedUnchanged: unrelated === originalUnrelated,
    publicFactoryStillExists: /makeTask/.test(model) && /createTask/.test(api),
    storeBoundaryStillExists: /saveTask/.test(store) && /getTask/.test(store),
  }
  return { passed: Object.values(checks).every(Boolean) && Object.values(hiddenTests).every(Boolean), checks, hiddenTests }
}

async function loadOrCreateState(config: ExperimentConfig): Promise<BenchmarkState> {
  if (resumePath) {
    const parsed = JSON.parse(await readFile(resumePath, 'utf8')) as Checkpoint
    validateCheckpoint(parsed, config, resumePath)
    const interrupted = parsed.activeTrial
    if (parsed.activeTrial) {
      delete parsed.activeTrial
    }
    const state = { checkpoint: parsed, reportWritten: false }
    // Reassert the deterministic source fixture in case the process stopped
    // between the fixture-created checkpoint and the fixture write itself.
    await createFixtureRoot(parsed.paths.root)
    await persist(state, 'resume.loaded', {
      completed: parsed.completedTrials.length,
      ...(interrupted ? { rerun: { repeat: interrupted.repeat, arm: interrupted.arm, stage: interrupted.stage } } : {}),
    })
    return state
  }
  const runID = `${EXPERIMENT}-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomBytes(3).toString('hex')}`
  const root = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'cuppet-stm-compaction-'))
  const paths = {
    root,
    checkpoint: join(resultsDirectory, `${runID}.checkpoint.json`),
    eventLog: join(resultsDirectory, `${runID}.events.ndjson`),
    partialJson: join(resultsDirectory, `${runID}.partial.json`),
    partialMarkdown: join(resultsDirectory, `${runID}.partial.md`),
  }
  const checkpoint: Checkpoint = {
    schema: SCHEMA,
    runID,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config,
    paths,
    completedTrials: [],
    telemetry: {},
    lastEvent: 'created',
    heartbeatAt: new Date().toISOString(),
  }
  const state = { checkpoint, reportWritten: false }
  await persist(state, 'created', { config, paths })
  await createFixtureRoot(root)
  await persist(state, 'fixture.created', { fixtureHash: config.fixtureHash })
  return state
}

async function persist(state: BenchmarkState, event: string, details: Record<string, unknown> = {}): Promise<void> {
  const operation = persistenceTail.then(async () => {
    const now = new Date().toISOString()
    state.checkpoint.lastEvent = event
    state.checkpoint.updatedAt = now
    state.checkpoint.heartbeatAt = now
    if (state.checkpoint.activeTrial) state.checkpoint.activeTrial.heartbeatAt = now
    state.checkpoint.telemetry = {
      ...state.checkpoint.telemetry,
      lastEvent: event,
      ...(state.checkpoint.activeTrial ? { activeTrial: state.checkpoint.activeTrial.telemetry } : {}),
    }
    if (details.error) state.checkpoint.error = details.error as Checkpoint['error']
    await appendEvent(state.checkpoint.paths.eventLog, {
      schema: SCHEMA,
      at: now,
      event,
      details,
      heartbeatAt: now,
    })
    await writeAtomic(state.checkpoint.paths.checkpoint, `${JSON.stringify(state.checkpoint, null, 2)}\n`)
  })
  persistenceTail = operation.catch(() => undefined)
  await operation
}

async function writePartialReport(state: BenchmarkState, config: ExperimentConfig): Promise<void> {
  const report = buildReport(state.checkpoint, config)
  await writeAtomic(state.checkpoint.paths.partialJson, `${JSON.stringify(report, null, 2)}\n`)
  await writeAtomic(state.checkpoint.paths.partialMarkdown, renderMarkdown(report))
}

function buildReport(checkpoint: Checkpoint, config: ExperimentConfig): Record<string, unknown> {
  const trials = checkpoint.completedTrials
  const summary = Object.fromEntries((['control', 'stm_only'] as Arm[]).map((arm) => {
    const values = trials.filter((trial) => trial.arm === arm)
    const successful = values.filter((trial) => trial.success)
    return [arm, {
      trials: values.length,
      successes: successful.length,
      correctnessRate: ratio(successful.length, values.length),
      medianContextTokens: median(values.map((trial) => trial.injectedTokens)),
      medianCompactionTokens: median(values.map((trial) => trial.compactionTokens)),
      medianTotalInputTokens: median(values.map((trial) => trial.totalInputTokens)),
      medianLatencyMs: median(values.map((trial) => trial.latencyMs)),
      medianCost: median(values.map((trial) => trial.cost)),
      medianFilePrecision: median(values.map((trial) => trial.retainedFilePrecision)),
      medianFileRecall: median(values.map((trial) => trial.retainedFileRecall)),
      meanConstraintRecall: mean(values.map((trial) => trial.constraintRecall)),
      meanStmSize: mean(values.map((trial) => trial.stmSize)),
      failures: values.flatMap((trial) => trial.failures),
    }]
  }))
  const control = summary.control as Record<string, any>
  const experiment = summary.stm_only as Record<string, any>
  return {
    schema: SCHEMA,
    experiment: EXPERIMENT,
    createdAt: checkpoint.createdAt,
    updatedAt: checkpoint.updatedAt,
    project,
    configuration: config,
    audit: {
      checkpoint: checkpoint.paths.checkpoint,
      eventLog: checkpoint.paths.eventLog,
      partialJson: checkpoint.paths.partialJson,
      partialMarkdown: checkpoint.paths.partialMarkdown,
      root: checkpoint.paths.root,
      lastEvent: checkpoint.lastEvent,
      heartbeatAt: checkpoint.heartbeatAt,
    },
    summary: {
      control,
      stm_only: experiment,
      comparison: {
        noCorrectnessRegression: experiment.correctnessRate >= control.correctnessRate,
        criticalChecksPass: trials.filter((trial) => trial.arm === 'stm_only').every((trial) => trial.success),
        medianContextCostReduction: ratio(
          control.medianContextTokens + control.medianCompactionTokens - experiment.medianContextTokens - experiment.medianCompactionTokens,
          control.medianContextTokens + control.medianCompactionTokens,
        ),
        worthwhile: experiment.correctnessRate >= control.correctnessRate &&
          experiment.medianContextTokens + experiment.medianCompactionTokens < control.medianContextTokens + control.medianCompactionTokens,
      },
    },
    completedTrials: trials,
    activeTrial: checkpoint.activeTrial,
    error: checkpoint.error,
  }
}

function renderMarkdown(report: Record<string, unknown>): string {
  const summary = report.summary as Record<string, any> | undefined
  const control = summary?.control ?? {}
  const experimental = summary?.stm_only ?? {}
  const comparison = summary?.comparison ?? {}
  return [
    `# Experimental STM-only compaction A/B`,
    '',
    `- Completed trials: ${(report.completedTrials as unknown[] | undefined)?.length ?? 0}`,
    `- Control correctness: ${control.correctnessRate ?? 0}`,
    `- STM-only correctness: ${experimental.correctnessRate ?? 0}`,
    `- Control median context + compaction tokens: ${(control.medianContextTokens ?? 0) + (control.medianCompactionTokens ?? 0)}`,
    `- STM-only median context + compaction tokens: ${(experimental.medianContextTokens ?? 0) + (experimental.medianCompactionTokens ?? 0)}`,
    `- No correctness regression: ${comparison.noCorrectnessRegression === true}`,
    `- Critical checks pass: ${comparison.criticalChecksPass === true}`,
    `- Worthwhile: ${comparison.worthwhile === true}`,
    '',
    `Checkpoint: ${String((report.audit as Record<string, unknown> | undefined)?.checkpoint ?? '')}`,
    `Event log: ${String((report.audit as Record<string, unknown> | undefined)?.eventLog ?? '')}`,
    '',
  ].join('\n')
}

async function createFixtureRoot(root: string): Promise<void> {
  await mkdir(join(root, 'fixture'), { recursive: true, mode: 0o700 })
  for (const [path, contents] of Object.entries(FIXTURE)) {
    const target = join(root, 'fixture', path)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await writeFile(target, contents, { encoding: 'utf8', mode: 0o600 })
  }
}

async function seedOpenCodeProviderState(paths: Awaited<ReturnType<typeof createRuntimePaths>>): Promise<void> {
  const persistentRoot = join(homedir(), '.cuppet', 'v2', 'opencode')
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

async function cloneFixture(destination: string): Promise<void> {
  const source = join(currentRootFromState(), 'fixture')
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  await rm(destination, { recursive: true, force: true })
  await cp(source, destination, { recursive: true })
}

// The active checkpoint root is resolved from the only stateful call site by
// runArm. Keeping this small indirection avoids copying the fixture from the
// repository and makes resume use the original deterministic fixture root.
let activeRoot = ''
function currentRootFromState(): string {
  if (!activeRoot) throw new Error('benchmark fixture root is not initialized')
  return activeRoot
}

async function waitForIndex(runtime: TstRuntime): Promise<void> {
  const deadline = Date.now() + 3 * 60_000
  while (Date.now() < deadline) {
    const status = await runtime.client.call<{ graph?: { progress?: { complete?: boolean } } }>('status')
    if (status.graph?.progress?.complete) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  throw new Error('TST graph indexing timed out')
}

async function syntheticTokenCount(gateway: OpenCodeGateway, sessionID: string): Promise<number> {
  const messages = await gateway.messages(sessionID)
  const bytes = messages.reduce<number>((total, item) => {
    if (!item || typeof item !== 'object') return total
    const message = item as { parts?: Array<{ text?: string; synthetic?: boolean }> }
    const syntheticBytes = (message.parts ?? [])
      .filter((part) => part.synthetic === true && typeof part.text === 'string')
      .reduce<number>((sum, part) => sum + Buffer.byteLength(part.text ?? ''), 0)
    return total + syntheticBytes
  }, 0)
  return Math.ceil(bytes / 4)
}

function normalizeFixturePath(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  const marker = normalized.indexOf('src/')
  return marker >= 0 ? normalized.slice(marker) : normalized.replace(/^\.\//, '')
}

function hashFixture(): string {
  const hash = createHash('sha256')
  for (const path of Object.keys(FIXTURE).sort()) {
    hash.update(path)
    hash.update('\0')
    hash.update(FIXTURE[path]!)
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function hashPatchSet(): Promise<string> {
  const hash = createHash('sha256')
  const directory = join(project, 'patches', 'opencode')
  for (const name of (await readdir(directory)).filter((item) => /^\d{4}-.*\.patch$/.test(item)).sort()) {
    hash.update(name)
    hash.update(await readFile(join(directory, name)))
  }
  return hash.digest('hex')
}

function validateCheckpoint(checkpoint: Checkpoint, config: ExperimentConfig, path: string): void {
  if (checkpoint.schema !== SCHEMA) throw new Error(`cannot resume ${path}: unsupported checkpoint schema`)
  const fields: Array<[string, boolean]> = [
    ['experiment', checkpoint.config?.experiment === config.experiment],
    ['model', JSON.stringify(checkpoint.config?.model) === JSON.stringify(config.model)],
    ['repeat count', checkpoint.config?.repeats === config.repeats],
    ['fixture hash', checkpoint.config?.fixtureHash === config.fixtureHash],
    ['patch digest', checkpoint.config?.patchSetDigest === config.patchSetDigest],
    ['arm order', JSON.stringify(checkpoint.config?.armOrders) === JSON.stringify(config.armOrders)],
  ]
  const mismatch = fields.find(([, matches]) => !matches)
  if (mismatch) throw new Error(`cannot resume ${path}: ${mismatch[0]} does not match current experiment configuration`)
  if (!checkpoint.paths?.root || !checkpoint.paths?.eventLog || !checkpoint.paths?.checkpoint) {
    throw new Error(`cannot resume ${path}: checkpoint paths are incomplete`)
  }
  for (const [name, value] of Object.entries(checkpoint.paths)) {
    if (!isAbsolute(value)) throw new Error(`cannot resume ${path}: ${name} path must be absolute`)
  }
  if (!Array.isArray(checkpoint.completedTrials)) {
    throw new Error(`cannot resume ${path}: completedTrials must be an array`)
  }
  try {
    validateCompletedPairs(checkpoint.completedTrials, config.repeats)
  } catch (error) {
    throw new Error(`cannot resume ${path}: ${errorMessage(error)}`)
  }
}

async function appendEvent(path: string, event: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const previous = await readFile(path, 'utf8').catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  })
  await writeAtomic(path, `${previous}${JSON.stringify(event)}\n`)
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

function parseRepeats(value: string | undefined): number {
  const parsed = value === undefined ? DEFAULT_REPEATS : Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_REPEATS) {
    throw new Error(`CUPPET_STM_COMPACTION_REPEATS must be an integer from 1 to ${MAX_REPEATS}`)
  }
  return parsed
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

function zeroUsage(): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

function serializeError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message, ...(error.stack ? { stack: error.stack } : {}) }
  return { message: String(error) }
}

function errorMessage(error: unknown): string {
  return serializeError(error).message
}

main().catch((error) => {
  process.stderr.write(`STM compaction benchmark failed: ${errorMessage(error)}\n`)
  process.exitCode = 1
})
