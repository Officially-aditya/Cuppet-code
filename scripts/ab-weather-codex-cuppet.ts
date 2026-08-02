import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { OpenCodeGateway } from '../packages/cli/src/opencode/gateway.js'
import { OPENCODE_VERSION } from '../packages/cli/src/constants.js'
import { resolveRuntimeAssets } from '../packages/cli/src/runtime/assets.js'
import { RedactedLogger } from '../packages/cli/src/runtime/logger.js'
import { createRuntimePaths } from '../packages/cli/src/runtime/paths.js'
import { startOpenCodeServer } from '../packages/cli/src/opencode/server.js'
import { startTstDaemon, type TstRuntime } from '../packages/cli/src/tst/supervisor.js'
import type { AgentEvent, ModelRef, TokenUsage } from '../packages/cli/src/types.js'

type Arm = 'codex' | 'opencode' | 'cuppet'

type UsageStats = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  totalModel: number
  totalWithCache: number
}

type CommandResult = {
  passed: boolean
  code: number | string
  durationMs: number
  stdout: string
  stderr: string
  timedOut?: boolean
}

type Evaluation = {
  success: boolean
  passedChecks: number
  totalChecks: number
  checks: Record<string, { passed: boolean; detail: string }>
  hidden: CommandResult
  test: CommandResult
  typecheck: CommandResult
  cliHelp: CommandResult
  changedFiles: string[]
  diffStat: string
}

type CompactionEvent = {
  phase?: string
  type?: string
  itemType?: string
  at: string
}

type Trial = {
  arm: Arm
  repeat: number
  workspace: string
  runtimeRoot?: string
  sessionID?: string
  success: boolean
  agentDurationMs: number
  endToEndDurationMs: number
  setupDurationMs: number
  usage: UsageStats
  cost: number
  injectedContextTokens: number
  compaction: {
    done: boolean
    count: number
    tokenDelta: number
    events: CompactionEvent[]
  }
  toolCalls: number
  permissionRequests: number
  rejectedPermissions: number
  eventTypes: Record<string, number>
  evaluation: Evaluation
  finalMessage: string
  error?: string
  codex?: {
    exitCode: number | null
    parseErrors: number
    usageSnapshots: UsageStats[]
  }
}

type AnyRecord = Record<string, unknown>

type BenchmarkOpenCodeRuntime = {
  client: ReturnType<typeof createOpencodeClient>
  close(): Promise<void>
}

const execFile = promisify(execFileCallback)
const project = resolve(process.cwd())
const codexBinary = process.env.CUPPET_CODEX_BIN ?? 'codex'
const officialOpenCodeBinary = process.env.CUPPET_OFFICIAL_OPENCODE_BIN
  ?? '/private/tmp/cuppet-opencode-official-1.18.4/node_modules/opencode-darwin-arm64/bin/opencode'
const configuredArms = parseArms(process.env.CUPPET_WEATHER_ARMS)
const reportLabel = process.env.CUPPET_WEATHER_LABEL ?? configuredArms.join('-')
const repeats = Math.max(1, Math.min(3, Number(process.env.CUPPET_WEATHER_REPEATS ?? '1') || 1))
const keepWorkspaces = process.env.CUPPET_WEATHER_KEEP_WORKSPACES !== '0'
const timeoutMs = 15 * 60_000
const model: ModelRef = {
  providerID: 'openai',
  modelID: 'gpt-5.6-luna',
  variant: 'low',
}

const taskPrompt = `
Build a complete mini weather app in this repository. Work directly in the workspace, implement the app, add focused tests, run the tests and typecheck, and fix any failures. Do not stop at a plan or only describe code.

Requirements:
- Use TypeScript with the existing Node 22 + tsx toolchain. Do not add dependencies and do not use the network during development or tests.
- Create src/weather.ts exporting fetchWeather(city, fetchImpl?), weatherCodeToCondition(code), and formatWeather(weather).
- fetchWeather must use the Open-Meteo geocoding API to resolve a city and then the Open-Meteo forecast API for current conditions. The fetch implementation must be injectable so tests can use a fake fetch. URL-encode the city, handle non-2xx responses, reject an unknown city, and validate the important response fields.
- Return a small typed weather result containing the resolved city, temperature, wind speed, weather code/condition, and observation time. Map common WMO codes to readable conditions, including clear, rain, snow, and thunderstorm cases.
- Create src/cli.ts. It must support npm run start -- <city>, print a readable weather report, show useful --help text without making a request, and exit nonzero with a useful error when the city is missing or the request fails.
- Add focused tests under test/ for URL construction and fake-fetch behavior, weather-code mapping, formatting, unknown-city/error handling, and the CLI help contract.
- Add or preserve package scripts named test, typecheck, and start. Update README.md with setup, usage, and the no-network testing approach.
- Keep the design small and coherent. Do not edit files outside this mini project.

Before finishing, run npm test, npm run typecheck, and npm run start -- --help. In your final response, list changed files and the exact validation results.
`

const fixture = {
  'package.json': JSON.stringify({
    name: 'weather-mini-app',
    private: true,
    type: 'module',
    scripts: {
      test: 'node --import tsx --test test/weather.test.ts',
      typecheck: 'tsc --noEmit',
      start: 'node --import tsx src/cli.ts',
    },
  }, null, 2) + '\n',
  'tsconfig.json': JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ['src/**/*.ts', 'test/**/*.ts'],
  }, null, 2) + '\n',
  'README.md': '# Weather mini app\n\nBuild a small, tested Open-Meteo weather CLI here. Tests must remain network-free.\n',
}

async function main(): Promise<void> {
  const assets = await resolveRuntimeAssets()
  if (configuredArms.includes('cuppet') && (!assets.opencode || !assets.tst || !assets.plugin)) {
    throw new Error(`Cuppet runtime unavailable: ${assets.diagnostics.join('; ')}`)
  }
  if (configuredArms.includes('opencode')) {
    const version = await commandVersion(officialOpenCodeBinary)
    if (version.trim() !== OPENCODE_VERSION) {
      throw new Error(`Official OpenCode version mismatch: expected ${OPENCODE_VERSION}, received ${version || 'unknown'}`)
    }
  }

  const root = await mkdtemp(join('/private/tmp', `cuppet-weather-${reportLabel}-`))
  const fixtureHash = hashFixture()
  const trials: Trial[] = []
  try {
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const order = repeat % 2 === 0 ? configuredArms : [...configuredArms].reverse()
      for (const arm of order) {
        process.stdout.write(`[${repeat + 1}/${repeats}] weather app · ${arm}\n`)
        trials.push(await runTrial({ arm, repeat: repeat + 1, root, assets }))
      }
    }

    const report: AnyRecord = {
      schema: 1,
      createdAt: new Date().toISOString(),
      project,
      task: 'Create a dependency-free TypeScript Open-Meteo weather CLI with injectable fetch, tests, typecheck, help, and README.',
      model,
      ...(configuredArms.includes('codex') ? {
        codex: {
          binary: codexBinary,
          version: await commandVersion(codexBinary),
          reasoningEffort: 'low',
        },
      } : {}),
      ...(configuredArms.includes('opencode') ? {
        opencode: {
          binary: officialOpenCodeBinary,
          version: OPENCODE_VERSION,
          package: `opencode-ai@${OPENCODE_VERSION}`,
          reasoningEffort: 'low',
          server: 'unpatched upstream OpenCode server; no Cuppet plugin or TST daemon',
        },
      } : {}),
      ...(configuredArms.includes('cuppet') ? {
        cuppet: {
          opencode: assets.opencode,
          tst: assets.tst,
          plugin: assets.plugin,
        },
      } : {}),
      fixture: { hash: fixtureHash, files: Object.keys(fixture) },
      repeats,
      armOrder: configuredArms,
      design: 'fresh minimal Git workspace per arm; same prompt, fixture, model ID, low reasoning setting, no network/dependencies; the official OpenCode arm uses an unpatched upstream server, while Cuppet uses the live TST plugin path',
      summary: summarize(trials, configuredArms),
      trials: trials.map((trial) => keepWorkspaces ? trial : { ...trial, workspace: '<removed after evaluation>', runtimeRoot: undefined }),
      ...(keepWorkspaces ? { artifactsRoot: root } : {}),
    }
    const results = join(project, 'benchmarks', 'results')
    await mkdir(results, { recursive: true, mode: 0o700 })
    const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
    const jsonPath = join(results, `ab-weather-${reportLabel}-${stamp}.json`)
    const markdownPath = join(results, `ab-weather-${reportLabel}-${stamp}.md`)
    await writeAtomic(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
    await writeAtomic(markdownPath, renderMarkdown(report))
    process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`)
    process.stdout.write(`Raw result: ${jsonPath}\nSummary: ${markdownPath}\n`)
  } finally {
    if (!keepWorkspaces) await rm(root, { recursive: true, force: true }).catch(() => undefined)
    else process.stdout.write(`Artifacts: ${root}\n`)
  }
}

async function runTrial(options: {
  arm: Arm
  repeat: number
  root: string
  assets: { opencode?: string; tst?: string; plugin?: string }
}): Promise<Trial> {
  const workspace = join(options.root, `workspace-${options.arm}-${options.repeat}`)
  await createWorkspace(workspace)
  const trialStarted = performance.now()
  if (options.arm === 'codex') {
    return runCodexTrial(workspace, options.repeat, trialStarted)
  }
  return runOpenCodeTrial(options.arm, workspace, options.repeat, trialStarted, options.assets)
}

async function runCodexTrial(workspace: string, repeat: number, trialStarted: number): Promise<Trial> {
  const promptStarted = performance.now()
  const codex = await runCodex(workspace, taskPrompt)
  const evaluation = await evaluateWorkspace(workspace)
  const error = codex.exitCode === 0 && !codex.timedOut && evaluation.success
    ? undefined
    : codex.timedOut
      ? 'Codex timed out'
      : codex.stderr || `Codex exited with ${codex.exitCode ?? 'unknown'}`
  return {
    arm: 'codex',
    repeat,
    workspace,
    success: !error,
    agentDurationMs: Math.round(codex.durationMs),
    endToEndDurationMs: Math.round(performance.now() - trialStarted),
    setupDurationMs: Math.round(promptStarted - trialStarted),
    usage: codex.usage,
    cost: 0,
    injectedContextTokens: 0,
    compaction: {
      done: codex.compactionEvents.length > 0,
      count: codex.compactionEvents.length,
      tokenDelta: 0,
      events: codex.compactionEvents,
    },
    toolCalls: countCodexTools(codex.events),
    permissionRequests: 0,
    rejectedPermissions: 0,
    eventTypes: codex.eventTypes,
    evaluation,
    finalMessage: compact(codex.finalMessage, 4_000),
    ...(error ? { error: compact(error, 1_000) } : {}),
    codex: {
      exitCode: codex.exitCode,
      parseErrors: codex.parseErrors,
      usageSnapshots: codex.usageSnapshots,
    },
  }
}

async function runOpenCodeTrial(
  arm: 'opencode' | 'cuppet',
  workspace: string,
  repeat: number,
  trialStarted: number,
  assets: { opencode?: string; tst?: string; plugin?: string },
): Promise<Trial> {
  const runtimeRoot = join(dirnameForTrial(workspace), `runtime-${arm}-${repeat}`)
  const paths = await createRuntimePaths(workspace, runtimeRoot)
  await seedProviderState(paths)
  const logger = new RedactedLogger(paths.logs)
  let tst: TstRuntime | undefined
  let opencode: BenchmarkOpenCodeRuntime | undefined
  let gateway: OpenCodeGateway | undefined
  const errors: string[] = []
  const compactionEvents: CompactionEvent[] = []
  const compactionSnapshots: Array<Promise<{ phase: string; tokens: TokenUsage } | undefined>> = []
  const eventTypes: Record<string, number> = {}
  let toolCalls = 0
  let permissionRequests = 0
  let rejectedPermissions = 0
  let sessionID: string | undefined
  const setupFinished = performance.now()
  try {
    if (arm === 'cuppet') {
      tst = await startTstDaemon(assets.tst!, paths, logger)
      await waitForIndex(tst)
      opencode = await startOpenCodeServer({
        binary: assets.opencode!,
        paths,
        logger,
        plugin: assets.plugin!,
        tst: { socket: tst.socket, token: tst.token },
      })
      gateway = new OpenCodeGateway(opencode.client, workspace)
    } else {
      opencode = await startOfficialOpenCodeServer(officialOpenCodeBinary, paths, logger)
      gateway = new OpenCodeGateway(opencode.client, workspace, { foreground: 'build', background: 'general' })
    }
    const allowedPermissions = new Set([
      'read', 'edit', 'write', 'bash', 'glob', 'grep', 'lsp', 'question', 'todowrite', 'task',
      'cuppet_memory_search', 'cuppet_workspace_info', 'cuppet_graph_tree', 'cuppet_graph_search', 'cuppet_graph_trace',
    ])
    gateway.onEvent((event: AgentEvent) => {
      eventTypes[event.type] = (eventTypes[event.type] ?? 0) + 1
      if (event.type === 'tool-start') toolCalls += 1
      if (event.type === 'permission') {
        permissionRequests += 1
        const allowed = allowedPermissions.has(event.request.action)
        if (!allowed) rejectedPermissions += 1
        void gateway?.replyPermission(event.request.sessionID, event.request.id, allowed ? 'once' : 'reject')
          .catch((error) => logger.write('warn', `permission reply failed: ${String(error)}`))
      }
      if (event.type === 'error') errors.push(event.message)
      if (event.type === 'compaction') {
        const detail: CompactionEvent = { phase: event.phase, at: new Date().toISOString() }
        compactionEvents.push(detail)
        compactionSnapshots.push(
          gateway!.getSession(event.sessionID)
            .then((session) => ({ phase: event.phase, tokens: session.tokens }))
            .catch(() => undefined),
        )
      }
    })
    gateway.startEvents()
    const session = await gateway.createSession(model)
    sessionID = session.id
    const promptStarted = performance.now()
    let finalMessage = ''
    let failure: string | undefined
    try {
      await gateway.prompt(session.id, taskPrompt)
      await withTimeout(gateway.wait(session.id), timeoutMs, 'Cuppet timed out')
      finalMessage = assistantText(await gateway.messages(session.id))
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      await gateway.interrupt(session.id).catch(() => undefined)
    }
    const completed = await gateway.getSession(session.id).catch(() => session)
    await Promise.all(compactionSnapshots)
    const snapshots = (await Promise.all(compactionSnapshots)).filter(Boolean) as Array<{ phase: string; tokens: TokenUsage }>
    const tokenDelta = compactionTokenDelta(snapshots)
    const evaluation = await evaluateWorkspace(workspace)
    const synthetic = await syntheticTokenCount(gateway, session.id)
    const error = failure ?? errors[0] ?? (!evaluation.success ? 'workspace evaluation failed' : undefined)
    return {
      arm,
      repeat,
      workspace,
      runtimeRoot,
      sessionID,
      success: !error,
      agentDurationMs: Math.round(performance.now() - promptStarted),
      endToEndDurationMs: Math.round(performance.now() - trialStarted),
      setupDurationMs: Math.round(promptStarted - trialStarted),
      usage: usageFromCuppet(completed.tokens),
      cost: completed.cost,
      injectedContextTokens: synthetic,
      compaction: {
        done: compactionEvents.some((event) => event.phase === 'ended'),
        count: compactionEvents.filter((event) => event.phase === 'started').length || compactionEvents.length,
        tokenDelta,
        events: compactionEvents,
      },
      toolCalls,
      permissionRequests,
      rejectedPermissions,
      eventTypes,
      evaluation,
      finalMessage: compact(finalMessage, 4_000),
      ...(error ? { error: compact(error, 1_000) } : {}),
    }
  } catch (error) {
    const evaluation = await evaluateWorkspace(workspace)
    return {
      arm,
      repeat,
      workspace,
      runtimeRoot,
      ...(sessionID ? { sessionID } : {}),
      success: false,
      agentDurationMs: Math.round(performance.now() - setupFinished),
      endToEndDurationMs: Math.round(performance.now() - trialStarted),
      setupDurationMs: Math.round(setupFinished - trialStarted),
      usage: zeroUsage(),
      cost: 0,
      injectedContextTokens: 0,
      compaction: { done: false, count: 0, tokenDelta: 0, events: compactionEvents },
      toolCalls,
      permissionRequests,
      rejectedPermissions,
      eventTypes,
      evaluation,
      finalMessage: '',
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await gateway?.close().catch(() => undefined)
    await opencode?.close().catch(() => undefined)
    await tst?.close().catch(() => undefined)
  }
}

async function startOfficialOpenCodeServer(
  binary: string,
  paths: Awaited<ReturnType<typeof createRuntimePaths>>,
  logger: RedactedLogger,
): Promise<BenchmarkOpenCodeRuntime> {
  const version = await commandVersion(binary)
  if (version.trim() !== OPENCODE_VERSION) {
    throw new Error(`Official OpenCode version mismatch: expected ${OPENCODE_VERSION}, received ${version || 'unknown'}`)
  }
  const username = 'official-benchmark'
  const password = randomBytes(32).toString('base64url')
  const config = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    default_agent: 'build',
    server: { mdns: false },
    experimental: { openTelemetry: false },
  }
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: paths.opencode.config,
    XDG_DATA_HOME: paths.opencode.data,
    XDG_CACHE_HOME: paths.opencode.cache,
    XDG_STATE_HOME: paths.opencode.state,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
  }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('CUPPET_')) delete environment[key]
  }
  const child = spawn(binary, ['serve', '--hostname=127.0.0.1', '--port=0', '--mdns=false'], {
    cwd: paths.projectRealpath,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: environment,
  })
  child.stderr?.on('data', (chunk: Buffer) => void logger.write('warn', `official opencode: ${chunk.toString('utf8')}`))
  try {
    const url = await waitForOfficialListening(child)
    const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    const client = createOpencodeClient({
      baseUrl: url,
      directory: paths.projectRealpath,
      headers: { authorization },
    })
    const health = await client.global.health({ throwOnError: true })
    if (!(health.data as { healthy?: boolean } | undefined)?.healthy) {
      throw new Error('Official OpenCode health check did not report healthy')
    }
    return {
      client,
      async close() {
        try {
          await Promise.race([
            client.global.dispose({ throwOnError: true }),
            new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500)),
          ])
        } catch {
          // Process termination below is the final shutdown fallback.
        }
        if (child.exitCode === null) child.kill('SIGTERM')
      },
    }
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGTERM')
    throw error
  }
}

function waitForOfficialListening(child: ChildProcess): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!child.stdout) return rejectPromise(new Error('Official OpenCode stdout is unavailable'))
    const stdout = child.stdout
    let output = ''
    const timeout = setTimeout(() => {
      cleanup()
      rejectPromise(new Error(`Timed out waiting for official OpenCode server startup: ${compact(output, 1_000)}`))
    }, 15_000)
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      for (const line of output.split(/\r?\n/)) {
        const match = /^opencode server listening on (https?:\/\/\S+)/.exec(line.trim())
        if (!match?.[1]) continue
        cleanup()
        resolvePromise(match[1])
        return
      }
    }
    const onExit = (code: number | null) => {
      cleanup()
      rejectPromise(new Error(`Official OpenCode server exited with code ${code}: ${compact(output, 1_000)}`))
    }
    const onError = (error: Error) => {
      cleanup()
      rejectPromise(error)
    }
    const cleanup = () => {
      clearTimeout(timeout)
      stdout.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    stdout.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

async function runCodex(workspace: string, prompt: string): Promise<{
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  stderr: string
  finalMessage: string
  events: AnyRecord[]
  eventTypes: Record<string, number>
  compactionEvents: CompactionEvent[]
  parseErrors: number
  usage: UsageStats
  usageSnapshots: UsageStats[]
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = [
      '-a', 'never',
      '-s', 'workspace-write',
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '--model', model.modelID,
      '-c', 'model_reasoning_effort="low"',
      '-C', workspace,
      '-',
    ]
    const started = performance.now()
    let child
    try {
      child = spawn(codexBinary, args, {
        cwd: workspace,
        env: { ...process.env, CI: '1', NO_COLOR: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      rejectPromise(error)
      return
    }
    const events: AnyRecord[] = []
    const eventTypes: Record<string, number> = {}
    const compactionEvents: CompactionEvent[] = []
    const usageSnapshots: UsageStats[] = []
    let finalMessage = ''
    let parseErrors = 0
    let stdoutBuffer = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
      }, 3_000)
    }, timeoutMs)
    const consume = (chunk: Buffer): void => {
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split(/\r?\n/)
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed) as AnyRecord
          events.push(event)
          const type = stringValue(event.type) || 'unknown'
          eventTypes[type] = (eventTypes[type] ?? 0) + 1
          const item = asRecord(event.item)
          const itemType = stringValue(item.type)
          const usage = usageFromCodex(event.usage ?? item.usage)
          if (usage) usageSnapshots.push(usage)
          if (type === 'item.completed' && itemType === 'agent_message') {
            finalMessage = stringValue(item.text) || stringValue(event.text) || finalMessage
          }
          if (type === 'agent_message') finalMessage = stringValue(event.text) || finalMessage
          if (type.toLowerCase().includes('compaction') || itemType.toLowerCase().includes('compaction')) {
            compactionEvents.push({ type, ...(itemType ? { itemType } : {}), at: new Date().toISOString() })
          }
        } catch {
          parseErrors += 1
        }
      }
    }
    child.stdout.on('data', consume)
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-20_000)
    })
    child.on('error', rejectPromise)
    child.on('close', (code) => {
      clearTimeout(timer)
      if (stdoutBuffer.trim()) {
        try {
          consume(Buffer.from('\n'))
        } catch {
          parseErrors += 1
        }
      }
      resolvePromise({
        exitCode: code,
        timedOut,
        durationMs: performance.now() - started,
        stderr: compact(stderr, 2_000),
        finalMessage,
        events,
        eventTypes,
        compactionEvents,
        parseErrors,
        usage: usageSnapshots.at(-1) ?? zeroUsage(),
        usageSnapshots,
      })
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}

async function evaluateWorkspace(workspace: string): Promise<Evaluation> {
  const files = await listFiles(workspace)
  const packageJson = await readJson(join(workspace, 'package.json'))
  const scripts = asRecord(packageJson?.scripts)
  const source = await Promise.all(
    files.filter((file) => file.startsWith('src/') && file.endsWith('.ts')).map((file) => readFile(join(workspace, file), 'utf8')),
  ).then((values) => values.join('\n'))
  const hiddenPath = join(workspace, `.weather-hidden-${randomBytes(4).toString('hex')}.ts`)
  await writeFile(hiddenPath, hiddenContract(), 'utf8')
  const hidden = await runCommand(process.execPath, ['--import', 'tsx', hiddenPath], workspace, 60_000, {
    WEATHER_WORKSPACE: workspace,
  })
  await rm(hiddenPath, { force: true }).catch(() => undefined)
  const test = await runCommand('npm', ['run', 'test'], workspace, 120_000)
  const typecheck = await runCommand('npm', ['run', 'typecheck'], workspace, 120_000)
  const cliHelp = await runCommand('npm', ['run', 'start', '--', '--help'], workspace, 20_000)
  const status = await runCommand('git', ['status', '--short'], workspace, 10_000)
  const diff = await runCommand('git', ['diff', '--stat'], workspace, 10_000)
  const checks: Evaluation['checks'] = {
    weatherModule: { passed: files.includes('src/weather.ts'), detail: 'src/weather.ts exists' },
    cliModule: { passed: files.includes('src/cli.ts'), detail: 'src/cli.ts exists' },
    tests: { passed: files.some((file) => /^test\/.*\.test\.ts$/.test(file)), detail: 'focused test file exists' },
    scripts: {
      passed: ['test', 'typecheck', 'start'].every((name) => typeof scripts[name] === 'string'),
      detail: 'test, typecheck, and start scripts are present',
    },
    weatherSignals: {
      passed: /fetch|Open-Meteo|open-meteo/i.test(source) && /weatherCodeToCondition|formatWeather|fetchWeather/.test(source),
      detail: 'source contains an injectable weather fetch, mapping, and formatter',
    },
    hiddenContract: { passed: hidden.passed, detail: summarizeCommand(hidden) },
    focusedTests: { passed: test.passed, detail: summarizeCommand(test) },
    typecheck: { passed: typecheck.passed, detail: summarizeCommand(typecheck) },
    cliHelp: { passed: cliHelp.passed, detail: summarizeCommand(cliHelp) },
  }
  const passedChecks = Object.values(checks).filter((check) => check.passed).length
  return {
    success: passedChecks === Object.keys(checks).length,
    passedChecks,
    totalChecks: Object.keys(checks).length,
    checks,
    hidden,
    test,
    typecheck,
    cliHelp,
    changedFiles: status.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    diffStat: compact(diff.stdout, 2_000),
  }
}

function hiddenContract(): string {
  return `
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = process.env.WEATHER_WORKSPACE
if (!root) throw new Error('WEATHER_WORKSPACE is missing')
const api = await import(pathToFileURL(join(root, 'src', 'weather.ts')).href)
assert.equal(typeof api.fetchWeather, 'function')
assert.equal(typeof api.weatherCodeToCondition, 'function')
assert.equal(typeof api.formatWeather, 'function')
assert.match(String(api.weatherCodeToCondition(0)), /clear|sun/i)
assert.match(String(api.weatherCodeToCondition(61)), /rain/i)
assert.match(String(api.weatherCodeToCondition(95)), /thunder/i)

const calls = []
const fakeFetch = async (input) => {
  const url = String(input)
  calls.push(url)
  if (url.includes('geocoding-api')) return { ok: true, status: 200, json: async () => ({ results: [{ name: 'Bengaluru', latitude: 12.97, longitude: 77.59 }] }) }
  if (url.includes('api.open-meteo.com')) return { ok: true, status: 200, json: async () => ({ current: { temperature_2m: 24.5, wind_speed_10m: 8.2, weather_code: 61, time: '2026-08-01T12:00' }, current_units: { temperature_2m: '°C', wind_speed_10m: 'km/h' } }) }
  throw new Error('unexpected URL: ' + url)
}
const weather = await api.fetchWeather('Bengaluru', fakeFetch)
assert.equal(calls.length, 2)
assert.equal(new URL(calls[0]).searchParams.get('name'), 'Bengaluru')
assert.match(String(api.formatWeather(weather)), /Bengaluru/)
assert.match(String(api.formatWeather(weather)), /24\.5/)
assert.match(String(api.formatWeather(weather)), /rain/i)

await assert.rejects(
  () => api.fetchWeather('Unknown', async () => ({ ok: true, status: 200, json: async () => ({ results: [] }) })),
  /not found|no location|unknown/i,
)
console.log('hidden weather contract passed')
`
}

async function createWorkspace(workspace: string): Promise<void> {
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  for (const [path, contents] of Object.entries(fixture)) {
    const target = join(workspace, path)
    await mkdir(join(target, '..'), { recursive: true, mode: 0o700 })
    await writeFile(target, contents, { encoding: 'utf8', mode: 0o600 })
  }
  await symlink(join(project, 'node_modules'), join(workspace, 'node_modules'), 'dir')
  await runCommand('git', ['init', '--quiet'], workspace, 10_000)
  await runCommand('git', ['add', '.'], workspace, 10_000)
  await runCommand('git', ['-c', 'user.name=Weather Benchmark', '-c', 'user.email=weather-benchmark@example.invalid', 'commit', '--quiet', '-m', 'initial fixture'], workspace, 10_000)
}

async function seedProviderState(paths: Awaited<ReturnType<typeof createRuntimePaths>>): Promise<void> {
  const persistentRoot = join(homedir(), '.cuppet', 'v2', 'opencode')
  for (const [source, target] of [
    [join(persistentRoot, 'data', 'opencode', 'auth.json'), join(paths.opencode.data, 'opencode', 'auth.json')],
    [join(persistentRoot, 'cache', 'opencode', 'models.json'), join(paths.opencode.cache, 'opencode', 'models.json')],
  ] as const) {
    try {
      await mkdir(join(target, '..'), { recursive: true, mode: 0o700 })
      const value = await readFile(source)
      await writeFile(target, value, { mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

async function waitForIndex(runtime: TstRuntime): Promise<void> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const status = await runtime.client.call<{ graph?: { progress?: { complete?: boolean } } }>('status')
    if (status.graph?.progress?.complete) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error('TST graph index timed out')
}

async function syntheticTokenCount(gateway: OpenCodeGateway, sessionID: string): Promise<number> {
  const messages = await gateway.messages(sessionID)
  let characters = 0
  for (const message of messages) {
    const value = asRecord(message)
    for (const part of arrayValue(value.parts)) {
      const item = asRecord(part)
      if (item.synthetic === true && typeof item.text === 'string') characters += item.text.length
    }
  }
  return Math.ceil(characters / 4)
}

function usageFromCuppet(value: TokenUsage): UsageStats {
  const totalModel = value.input + value.output + value.reasoning
  return {
    input: value.input,
    output: value.output,
    reasoning: value.reasoning,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
    totalModel,
    totalWithCache: totalModel + value.cacheRead + value.cacheWrite,
  }
}

function usageFromCodex(value: unknown): UsageStats | undefined {
  const usage = asRecord(value)
  if (Object.keys(usage).length === 0) return undefined
  const input = numberValue(usage.input_tokens ?? usage.input)
  const output = numberValue(usage.output_tokens ?? usage.output)
  const reasoning = numberValue(usage.reasoning_output_tokens ?? usage.reasoning_tokens ?? usage.reasoning)
  const cacheRead = numberValue(usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? usage.cacheRead)
  const cacheWrite = numberValue(usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens ?? usage.cacheWrite)
  if (input + output + reasoning + cacheRead + cacheWrite === 0) return undefined
  return { input, output, reasoning, cacheRead, cacheWrite, totalModel: input + output + reasoning, totalWithCache: input + output + reasoning + cacheRead + cacheWrite }
}

function compactionTokenDelta(snapshots: Array<{ phase: string; tokens: TokenUsage }>): number {
  const started = snapshots.find((item) => item.phase === 'started')
  const ended = [...snapshots].reverse().find((item) => item.phase === 'ended')
  return started && ended ? Math.max(0, ended.tokens.input - started.tokens.input) : 0
}

function countCodexTools(events: AnyRecord[]): number {
  return events.filter((event) => {
    const type = stringValue(event.type)
    const itemType = stringValue(asRecord(event.item).type)
    return type === 'item.started' && ['command_execution', 'file_change', 'mcp_tool_call', 'web_search_call'].includes(itemType)
  }).length
}

async function commandVersion(command: string): Promise<string> {
  const result = await runCommand(command, ['--version'], project, 10_000)
  return compact(`${result.stdout} ${result.stderr}`, 300)
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(prefix, entry.name)
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'target' || entry.name === 'dist') continue
    if (entry.isDirectory()) files.push(...await listFiles(root, path))
    else if (entry.isFile()) files.push(path)
  }
  return files
}

async function readJson(path: string): Promise<AnyRecord | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as AnyRecord
  } catch {
    return undefined
  }
}

async function runCommand(command: string, args: string[], cwd: string, timeout: number, extraEnv: Record<string, string> = {}): Promise<CommandResult> {
  const started = performance.now()
  try {
    const result = await execFile(command, args, {
      cwd,
      env: { ...process.env, CI: '1', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false', ...extraEnv },
      timeout,
      maxBuffer: 500_000,
    })
    return { passed: true, code: 0, durationMs: Math.round(performance.now() - started), stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean }
    return { passed: false, code: failure.code ?? 1, durationMs: Math.round(performance.now() - started), stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message, ...(failure.killed ? { timedOut: true } : {}) }
  }
}

function summarizeCommand(result: CommandResult): string {
  if (result.passed) return `passed in ${result.durationMs} ms`
  return `failed (${compact(`${result.stderr} ${result.stdout}`, 220) || `exit ${result.code}`})`
}

function summarize(trials: Trial[], armOrder: readonly [Arm, Arm]) {
  const summarizeArm = (name: Arm) => {
    const values = trials.filter((trial) => trial.arm === name)
    return {
      trials: values.length,
      successes: values.filter((trial) => trial.success).length,
      medianAgentDurationMs: median(values.map((trial) => trial.agentDurationMs)),
      medianEndToEndDurationMs: median(values.map((trial) => trial.endToEndDurationMs)),
      medianInputTokens: median(values.map((trial) => trial.usage.input)),
      medianOutputTokens: median(values.map((trial) => trial.usage.output)),
      medianReasoningTokens: median(values.map((trial) => trial.usage.reasoning)),
      medianTotalModelTokens: median(values.map((trial) => trial.usage.totalModel)),
      medianTotalWithCacheTokens: median(values.map((trial) => trial.usage.totalWithCache)),
      medianInjectedContextTokens: median(values.map((trial) => trial.injectedContextTokens)),
      compactions: values.reduce((sum, trial) => sum + trial.compaction.count, 0),
      compactionTrials: values.filter((trial) => trial.compaction.done).length,
      meanToolCalls: mean(values.map((trial) => trial.toolCalls)),
      meanAcceptance: mean(values.map((trial) => trial.evaluation.passedChecks / Math.max(1, trial.evaluation.totalChecks))),
    }
  }
  const arms = Object.fromEntries(armOrder.map((name) => [name, summarizeArm(name)])) as Record<Arm, ReturnType<typeof summarizeArm>>
  const baseline = arms[armOrder[0]]
  const candidate = arms[armOrder[1]]
  return {
    ...arms,
    comparison: {
      baseline: armOrder[0],
      candidate: armOrder[1],
      successDelta: candidate.successes / Math.max(1, candidate.trials) - baseline.successes / Math.max(1, baseline.trials),
      agentDurationReduction: ratio(baseline.medianAgentDurationMs - candidate.medianAgentDurationMs, baseline.medianAgentDurationMs),
      endToEndDurationReduction: ratio(baseline.medianEndToEndDurationMs - candidate.medianEndToEndDurationMs, baseline.medianEndToEndDurationMs),
      totalModelTokenReduction: ratio(baseline.medianTotalModelTokens - candidate.medianTotalModelTokens, baseline.medianTotalModelTokens),
      inputTokenReduction: ratio(baseline.medianInputTokens - candidate.medianInputTokens, baseline.medianInputTokens),
      acceptanceDelta: candidate.meanAcceptance - baseline.meanAcceptance,
    },
  }
}

function renderMarkdown(report: AnyRecord): string {
  const summary = asRecord(report.summary)
  const armOrder = arrayValue(report.armOrder).map(stringValue)
  const baselineName = armOrder[0] ?? stringValue(asRecord(summary.comparison).baseline)
  const candidateName = armOrder[1] ?? stringValue(asRecord(summary.comparison).candidate)
  const baseline = asRecord(summary[baselineName])
  const candidate = asRecord(summary[candidateName])
  const comparison = asRecord(summary.comparison)
  const rows = [
    ['Successes', `${baseline.successes}/${baseline.trials}`, `${candidate.successes}/${candidate.trials}`, numberValue(comparison.successDelta).toFixed(2)],
    ['Median agent time', `${baseline.medianAgentDurationMs} ms`, `${candidate.medianAgentDurationMs} ms`, `${(numberValue(comparison.agentDurationReduction) * 100).toFixed(1)}%`],
    ['Median end-to-end time', `${baseline.medianEndToEndDurationMs} ms`, `${candidate.medianEndToEndDurationMs} ms`, `${(numberValue(comparison.endToEndDurationReduction) * 100).toFixed(1)}%`],
    ['Median input tokens', String(baseline.medianInputTokens), String(candidate.medianInputTokens), `${(numberValue(comparison.inputTokenReduction) * 100).toFixed(1)}%`],
    ['Median total model tokens', String(baseline.medianTotalModelTokens), String(candidate.medianTotalModelTokens), `${(numberValue(comparison.totalModelTokenReduction) * 100).toFixed(1)}%`],
    ['Compaction trials', `${baseline.compactionTrials}/${baseline.trials}`, `${candidate.compactionTrials}/${candidate.trials}`, 'tracked automatically'],
    ['Median injected context', String(baseline.medianInjectedContextTokens), String(candidate.medianInjectedContextTokens), `${candidateName}-side overhead`],
    ['Mean acceptance', `${(numberValue(baseline.meanAcceptance) * 100).toFixed(1)}%`, `${(numberValue(candidate.meanAcceptance) * 100).toFixed(1)}%`, `${(numberValue(comparison.acceptanceDelta) * 100).toFixed(1)} pp`],
  ]
  const trials = Array.isArray(report.trials) ? report.trials : []
  return [
    `# ${armLabel(baselineName)} vs ${armLabel(candidateName)} weather-app trial`,
    '',
    `- Created: ${String(report.createdAt)}`,
    '- Model: `openai/gpt-5.6-luna`, reasoning effort/variant: `low`',
    '- Each arm used a fresh minimal Git workspace and the same task prompt.',
    '',
    `| Metric | ${armLabel(baselineName)} | ${armLabel(candidateName)} | Candidate minus baseline |`,
    '|---|---:|---:|---:|',
    ...rows.map((row) => `| ${row[0]} | ${row[1]} | ${row[2]} | ${row[3]} |`),
    '',
    '## Trial details',
    '',
    ...trials.map((trial) => {
      const value = asRecord(trial)
      const evaluation = asRecord(value.evaluation)
      const compaction = asRecord(value.compaction)
      return `- ${value.arm}: ${value.success ? 'success' : 'failure'}; acceptance ${evaluation.passedChecks}/${evaluation.totalChecks}; ${value.agentDurationMs} ms agent time; ${value.endToEndDurationMs} ms end-to-end; ${value.usage && asRecord(value.usage).totalModel} model tokens; compaction ${compaction.done ? 'yes' : 'no'} (${compaction.count ?? 0})`
    }),
    '',
    'This is one small paired task unless repeats are increased; treat the result as directional, not a general model ranking.',
    '',
  ].join('\n')
}

function hashFixture(): string {
  const hash = createHash('sha256')
  for (const path of Object.keys(fixture).sort()) hash.update(path).update('\0').update(fixture[path]!)
  return hash.digest('hex')
}

function parseArms(value: string | undefined): [Arm, Arm] {
  const arms = (value ?? 'codex,cuppet').split(',').map((item) => item.trim()).filter(Boolean)
  if (arms.length !== 2 || new Set(arms).size !== 2 || arms.some((item) => !['codex', 'opencode', 'cuppet'].includes(item))) {
    throw new Error('CUPPET_WEATHER_ARMS must contain two distinct arms from codex,opencode,cuppet')
  }
  return arms as [Arm, Arm]
}

function armLabel(value: string): string {
  return value === 'opencode' ? 'OpenCode' : value[0]!.toUpperCase() + value.slice(1)
}

function dirnameForTrial(path: string): string {
  const marker = path.lastIndexOf(sep)
  return marker <= 0 ? path : path.slice(0, marker)
}

function assistantText(messages: unknown[]): string {
  return messages.flatMap((message) => {
    const value = asRecord(message)
    if (asRecord(value.info).role !== 'assistant') return []
    return arrayValue(value.parts).flatMap((part) => {
      const item = asRecord(part)
      return item.type === 'text' && typeof item.text === 'string' ? [item.text] : []
    })
  }).join('\n').trim()
}

function zeroUsage(): UsageStats {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalModel: 0, totalWithCache: 0 }
}

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {}
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function compact(value: string, limit: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit)
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

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

function withTimeout<T>(promise: Promise<T>, timeout: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), timeout)
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value) },
      (error) => { clearTimeout(timer); rejectPromise(error) },
    )
  })
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
  await (await import('node:fs/promises')).rename(temporary, path)
}

main().catch((error) => {
  process.stderr.write(`Weather Codex/Cuppet benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
