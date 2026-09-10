import { execFile as execFileCallback, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { resolveRuntimeAssets } from '../packages/cli/src/runtime/assets.js'

const execFile = promisify(execFileCallback)
const REQUIRED_DESKTOP_MERGE = 'a40d008d37eaf9c994679dea5d3a3135c4649a10'
const ALLOWED_PERMISSION_ACTIONS = new Set(['read', 'edit', 'write', 'bash'])
const scriptDirectory = dirname(fileURLToPath(import.meta.url))

const options = parseArgs(process.argv.slice(2))
const sequence = options.sequenceFile
  ? JSON.parse(await readFile(options.sequenceFile, 'utf8'))
  : [{ taskId: options.taskId, promptFile: options.promptFile, resultFile: options.resultFile, timeoutMs: options.timeoutMs, verification: [] }]

const results = await runDesktopSequence(options, sequence).catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  return sequence.map((entry) => failedResult(options, entry.taskId, message))
})

await Promise.all(results.map(async (result) => {
  const entry = sequence.find((candidate) => candidate.taskId === result.taskId)
  if (entry) await writeFile(entry.resultFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}))
process.stdout.write(`${JSON.stringify({ arm: 'cuppet', sequence: results.map((result) => ({ taskId: result.taskId, success: result.success, sessionId: result.sessionId })) })}\n`)
if (results.some((result) => !result.success)) process.exitCode = 1

async function runDesktopSequence(options, sequence) {
  process.env.CUPPET_DATA_DIR = options.runtimeRoot
  process.env.CUPPET_PE3 = '1'
  await mkdir(options.runtimeRoot, { recursive: true })

  const desktopRoot = resolveDesktopRoot()
  const desktop = await loadDesktopRuntime(desktopRoot)
  const desktopIdentity = await verifyDesktopIdentity(desktopRoot)
  const assets = await resolveRuntimeAssets()
  const tstBinary = process.env.CUPPET_TST_BIN?.trim() || assets.tst
  if (!tstBinary) throw new Error(`Desktop marathon requires a native TST daemon. ${assets.diagnostics.join('; ')}`)

  let service
  let activeFailure
  const counters = { toolCalls: 0, compactions: 0, permissionRequests: 0, rejectedPermissions: 0, eventCount: 0 }
  const emit = (event) => {
    counters.eventCount += 1
    if (event?.type === 'tool.started') counters.toolCalls += 1
    if (event?.type === 'context.compacted') counters.compactions += 1
    if (event?.type === 'runtime.error') activeFailure ??= String(event.message ?? 'Desktop runtime error')
    if (event?.type === 'permission.requested') {
      counters.permissionRequests += 1
      const action = String(event.request?.action ?? '')
      const allowed = ALLOWED_PERMISSION_ACTIONS.has(action)
      if (!allowed) counters.rejectedPermissions += 1
      queueMicrotask(() => void service?.handle('permission.reply', {
        requestId: event.request?.id,
        reply: allowed ? 'once' : 'reject',
      }).catch(() => undefined))
    }
    if (event?.type === 'question.requested') {
      queueMicrotask(() => void service?.handle('question.reject', { requestId: event.request?.id }).catch(() => undefined))
    }
  }

  const tst = new desktop.RuntimeTstManager({
    dataDir: join(options.runtimeRoot, 'tst'),
    binaryPath: tstBinary,
    idleMs: 0,
  })
  service = new desktop.RuntimeService({
    databasePath: join(options.runtimeRoot, 'conversations.sqlite3'),
    dataDir: options.runtimeRoot,
    interactive: true,
    emit,
    tst,
  })

  const provider = buildProviderConfiguration(options, desktop.normalizeProviderConfiguration)
  const results = []
  try {
    await service.handle('background.pause')
    const project = await service.handle('project.add-local', { path: options.workspace, name: 'Cuppet Desktop Marathon' })
    const projectId = project.id
    const projectRoot = project.canonicalPath
    const initialSession = await service.handle('session.create', { projectId })
    let activeSessionId = initialSession.id

    const tstHandle = await tst.forProject(projectId, projectRoot)
    await waitForIndex(tstHandle)

    const scoped = (method, params, sessionId = activeSessionId) => tst.runWithProject(
      { sessionId, projectId, projectRoot },
      () => service.handle(method, params),
    )

    for (const entry of sequence) {
      const startedAt = new Date().toISOString()
      const started = performance.now()
      const beforeUsage = await desktop.providerUsageSummary()
      const before = { ...counters }
      activeFailure = undefined
      let failure
      let finalMessage = ''
      let targetSessionId = activeSessionId

      try {
        const prompt = await readFile(entry.promptFile, 'utf8')
        const accepted = await withTimeout(
          scoped('session.send', { sessionId: activeSessionId, text: prompt, provider }, activeSessionId),
          Math.min(30_000, entry.timeoutMs),
          `cuppet desktop ${entry.taskId} did not accept the turn`,
        )
        targetSessionId = accepted.sessionId
        activeSessionId = targetSessionId
        const message = await waitForTerminalAssistant(scoped, targetSessionId, entry.timeoutMs)
        finalMessage = String(message.content ?? '')
        if (message.status === 'error') failure = finalMessage || 'Desktop generation failed'
        if (message.status === 'stopped') failure = 'Desktop generation stopped'
        failure ??= activeFailure
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
        await scoped('session.stop', { sessionId: targetSessionId }, targetSessionId).catch(() => undefined)
      }

      const verification = await runSequenceVerifiers(options.workspace, entry.verification ?? [])
      const afterUsage = await desktop.providerUsageSummary()
      const completedAt = new Date().toISOString()
      const usage = diffUsage(afterUsage, beforeUsage)
      const success = !failure
      results.push({
        schema: 1,
        arm: 'cuppet',
        taskId: entry.taskId,
        harnessVersion: desktopIdentity,
        sessionId: targetSessionId,
        startedAt,
        completedAt,
        durationMs: Math.round(performance.now() - started),
        success,
        attempts: 1,
        firstAttemptSuccess: success,
        retries: 0,
        usage,
        toolCalls: counters.toolCalls - before.toolCalls,
        compactions: counters.compactions - before.compactions,
        regressions: 0,
        permissionRequests: counters.permissionRequests - before.permissionRequests,
        rejectedPermissions: counters.rejectedPermissions - before.rejectedPermissions,
        telemetry: {
          source: 'native',
          complete: counters.eventCount > before.eventCount,
          eventCount: counters.eventCount - before.eventCount,
        },
        model: options.model,
        parity: {
          status: 'exact',
          notes: `Cuppet Desktop RuntimeService with PE3 + managed TST; provider transport ${provider.providerID}.`,
        },
        finalMessage,
        ...(verification.length > 0 ? { verification } : {}),
        ...(failure ? { error: failure } : {}),
      })
    }
  } finally {
    await service.close().catch(() => undefined)
    await tst.close().catch(() => undefined)
    await desktop.closeProviderUsageLedger().catch(() => undefined)
  }
  return results
}

function buildProviderConfiguration(options, normalizeProviderConfiguration) {
  const providerID = process.env.CUPPET_DESKTOP_BENCH_PROVIDER?.trim() || options.model.provider
  if (providerID === 'codex') {
    return {
      providerID: 'codex',
      model: options.model.model,
      primaryEffort: options.model.reasoningEffort,
    }
  }
  const apiKey = process.env.CUPPET_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || ''
  if (!apiKey) throw new Error(`Cuppet Desktop benchmark provider '${providerID}' requires CUPPET_API_KEY/OPENAI_API_KEY, or set CUPPET_DESKTOP_BENCH_PROVIDER=codex.`)
  const effort = options.model.reasoningEffort
  return normalizeProviderConfiguration({
    providerID,
    baseUrl: process.env.CUPPET_BASE_URL?.trim() || 'https://api.openai.com/v1',
    apiKey,
    model: options.model.model,
    backgroundModel: options.model.model,
    primary: { providerID, modelID: options.model.model, variant: effort },
    secondary: { providerID, modelID: options.model.model, variant: effort },
    models: [{
      providerID,
      modelID: options.model.model,
      name: options.model.model,
      context: Number(process.env.CUPPET_CONTEXT_WINDOW_TOKENS) || 128_000,
      outputLimit: 16_384,
      capabilities: { tools: true, streaming: true, input: ['text'], output: ['text'] },
      variants: [{ id: effort, body: providerID === 'openai' ? { reasoning: { effort } } : {} }],
    }],
  })
}

async function loadDesktopRuntime(root) {
  const importFile = (path) => import(pathToFileURL(join(root, path)).href)
  const [service, tst, policy, usage] = await Promise.all([
    importFile('src/runtime/service.mjs'),
    importFile('src/runtime/runtime-tst-manager.mjs'),
    importFile('src/runtime/provider-policy.mjs'),
    importFile('src/runtime/usage-ledger.mjs'),
  ])
  return {
    RuntimeService: service.RuntimeService,
    RuntimeTstManager: tst.RuntimeTstManager,
    normalizeProviderConfiguration: policy.normalizeProviderConfiguration,
    providerUsageSummary: usage.providerUsageSummary,
    closeProviderUsageLedger: usage.closeProviderUsageLedger,
  }
}

function resolveDesktopRoot() {
  const configured = process.env.CUPPET_DESKTOP_ROOT?.trim()
  return configured
    ? resolve(configured)
    : resolve(scriptDirectory, '..', '..', 'Cuppet-desktop')
}

async function verifyDesktopIdentity(root) {
  try {
    await execFile('git', ['merge-base', '--is-ancestor', REQUIRED_DESKTOP_MERGE, 'HEAD'], { cwd: root })
  } catch {
    throw new Error(`CUPPET_DESKTOP_ROOT must point to Cuppet-desktop at or after merged runtime commit ${REQUIRED_DESKTOP_MERGE}. Current root: ${root}`)
  }
  const [{ stdout }, pkg] = await Promise.all([
    execFile('git', ['rev-parse', 'HEAD'], { cwd: root }),
    readFile(join(root, 'package.json'), 'utf8').then((value) => JSON.parse(value)),
  ])
  return `Cuppet Desktop ${pkg.version ?? 'unknown'} @ ${stdout.trim().slice(0, 12)}`
}

async function waitForIndex(tstHandle) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const status = await tstHandle.call('status')
    if (status?.graph?.progress?.complete) return
    await delay(100)
  }
  throw new Error('Desktop benchmark TST graph index did not complete')
}

async function waitForTerminalAssistant(scoped, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const session = await scoped('session.get', { sessionId }, sessionId)
    const message = [...(session.messages ?? [])].reverse().find((item) => item.role === 'assistant')
    if (message && message.status !== 'streaming') return message
    if (Date.now() >= deadline) throw new Error(`cuppet desktop session ${sessionId} timed out`)
    await delay(25)
  }
}

function diffUsage(after, before) {
  const inputTokens = positiveDelta(after?.inputTokens, before?.inputTokens)
  const cachedInputTokens = positiveDelta(after?.cachedInputTokens, before?.cachedInputTokens)
  const outputTokens = positiveDelta(after?.outputTokens, before?.outputTokens)
  const reasoningTokens = positiveDelta(after?.reasoningTokens, before?.reasoningTokens)
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens)
  return {
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalModelTokens: uncachedInputTokens + outputTokens + reasoningTokens,
    effectiveCost: null,
  }
}

function positiveDelta(after, before) {
  const next = Number(after) || 0
  const previous = Number(before) || 0
  return Math.max(0, next - previous)
}

async function runSequenceVerifiers(workspace, specs) {
  return Promise.all(specs.map(async (spec) => {
    const started = performance.now()
    const execution = await runCommand(spec.command, spec.args, workspace, spec.timeoutMs)
    return {
      id: spec.id,
      command: spec.command,
      args: spec.args,
      passed: execution.exitCode === (spec.expectedExitCode ?? 0) && !execution.timedOut,
      exitCode: execution.exitCode,
      stdout: truncate(execution.stdout),
      stderr: truncate(execution.stderr),
      durationMs: Math.round(performance.now() - started),
    }
  }))
}

async function runCommand(command, args, cwd, timeoutMs) {
  const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  let timedOut = false
  const started = performance.now()
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 1_500).unref()
  }, timeoutMs)
  const exitCode = await new Promise((resolveExit) => {
    let settled = false
    const settle = (value) => { if (!settled) { settled = true; resolveExit(value) } }
    child.once('error', (error) => settle(error.message))
    child.once('close', (code, signal) => settle(code ?? signal ?? 'unknown'))
  })
  clearTimeout(timer)
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    durationMs: Math.round(performance.now() - started),
    timedOut,
  }
}

function failedResult(options, taskId, message) {
  const now = new Date().toISOString()
  return {
    schema: 1,
    arm: 'cuppet',
    taskId,
    harnessVersion: 'Cuppet Desktop unavailable',
    sessionId: `cuppet-${taskId}-${Date.now()}`,
    startedAt: now,
    completedAt: now,
    durationMs: 0,
    success: false,
    attempts: 1,
    firstAttemptSuccess: false,
    retries: 0,
    usage: { inputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalModelTokens: 0, effectiveCost: null },
    toolCalls: 0,
    compactions: 0,
    regressions: 0,
    permissionRequests: 0,
    rejectedPermissions: 0,
    telemetry: { source: 'unavailable', complete: false, eventCount: 0 },
    model: options.model,
    parity: { status: 'exact', notes: 'Cuppet Desktop RuntimeService benchmark arm.' },
    finalMessage: '',
    error: message,
  }
}

function parseArgs(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key?.startsWith('--')) continue
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`)
    values.set(key.slice(2), value)
    index += 1
  }
  if (values.get('arm') !== 'cuppet') throw new Error('benchmark-desktop-arm only supports --arm cuppet')
  const required = ['workspace', 'prompt-file', 'result-file', 'runtime-root', 'task-id', 'model', 'provider', 'reasoning-effort', 'timeout-ms', 'session-mode']
  for (const key of required) if (!values.get(key)) throw new Error(`missing --${key}`)
  return {
    arm: 'cuppet',
    workspace: resolve(values.get('workspace')),
    promptFile: resolve(values.get('prompt-file')),
    resultFile: resolve(values.get('result-file')),
    runtimeRoot: resolve(values.get('runtime-root')),
    taskId: values.get('task-id'),
    model: {
      provider: values.get('provider'),
      model: values.get('model'),
      reasoningEffort: values.get('reasoning-effort'),
    },
    timeoutMs: Number(values.get('timeout-ms')),
    sessionMode: values.get('session-mode'),
    ...(values.get('sequence-file') ? { sequenceFile: resolve(values.get('sequence-file')) } : {}),
  }
}

function truncate(value) {
  return value.length > 12_000 ? `${value.slice(0, 12_000)}\n…<truncated>` : value
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function withTimeout(promise, timeoutMs, message) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
