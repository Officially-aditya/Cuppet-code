import { execFile as execFileCallback, spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { PreferenceStore } from '../packages/cli/src/config/preferences.js'
import { OpenCodeGateway } from '../packages/cli/src/opencode/gateway.js'
import { startOpenCodeServer, type OpenCodeRuntime } from '../packages/cli/src/opencode/server.js'
import { resolveRuntimeAssets } from '../packages/cli/src/runtime/assets.js'
import { RedactedLogger } from '../packages/cli/src/runtime/logger.js'
import { createRuntimePaths } from '../packages/cli/src/runtime/paths.js'
import { buildCuppetContext } from '../packages/cli/src/tst/context.js'
import { startTstDaemon, type TstRuntime } from '../packages/cli/src/tst/supervisor.js'
import type { AgentEvent, ModelRef, TokenUsage } from '../packages/cli/src/types.js'
import { OPENCODE_VERSION } from '../packages/cli/src/constants.js'
import { seedCuppetOpenCodeProviderState } from './lib/cuppet-opencode-state.js'
import type { HarnessID, HarnessRunResult, ModelSpec, UsageTotals } from './lib/benchmark-contract.js'

type ArmOptions = {
  arm: HarnessID
  workspace: string
  promptFile: string
  resultFile: string
  runtimeRoot: string
  taskId: string
  model: ModelSpec
  timeoutMs: number
  sessionMode: 'isolated' | 'persistent'
  sequenceFile?: string
}

type SequenceEntry = {
  taskId: string
  promptFile: string
  resultFile: string
  timeoutMs: number
}

type ProcessResult = {
  exitCode: number | string
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

const execFile = promisify(execFileCallback)

const options = parseArgs(process.argv.slice(2))
if (options.sequenceFile) {
  const sequence = JSON.parse(await readFile(options.sequenceFile, 'utf8')) as SequenceEntry[]
  const results = await runSequence(options, sequence)
  await Promise.all(results.map(async (result) => {
    const entry = sequence.find((candidate) => candidate.taskId === result.taskId)
    if (entry) await writeFile(entry.resultFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  }))
  process.stdout.write(`${JSON.stringify({ arm: options.arm, sequence: results.map((result) => ({ taskId: result.taskId, success: result.success, sessionId: result.sessionId })) })}\n`)
  if (results.some((result) => !result.success)) process.exitCode = 1
} else {
  const prompt = await readFile(options.promptFile, 'utf8')
  const result = await run(options, prompt)
  await writeFile(options.resultFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ arm: result.arm, taskId: result.taskId, success: result.success, sessionId: result.sessionId })}\n`)
  if (!result.success) process.exitCode = 1
}

async function run(options: ArmOptions, prompt: string): Promise<HarnessRunResult> {
  try {
    if (options.arm === 'cuppet' || options.arm === 'opencode') return await runOpenCode(options, prompt)
    return await runExternal(options, prompt)
  } catch (error) {
    const completedAt = new Date().toISOString()
    const message = error instanceof Error ? error.message : String(error)
    return failedResult(options, message)
  }
}

function failedResult(options: ArmOptions, message: string): HarnessRunResult {
  const completedAt = new Date().toISOString()
  return {
    schema: 1,
    arm: options.arm,
    taskId: options.taskId,
    harnessVersion: 'unavailable',
    sessionId: `${options.arm}-${options.taskId}-${Date.now()}`,
    startedAt: completedAt,
    completedAt,
    durationMs: 0,
    success: false,
    attempts: 1,
    firstAttemptSuccess: false,
    retries: 0,
    usage: emptyUsage(),
    toolCalls: 0,
    compactions: 0,
    regressions: 0,
    permissionRequests: 0,
    rejectedPermissions: 0,
    telemetry: { source: 'unavailable', complete: false, eventCount: 0 },
    model: options.model,
    parity: parityFor(options.arm),
    finalMessage: '',
    error: message,
  }
}

async function runSequence(options: ArmOptions, sequence: SequenceEntry[]): Promise<HarnessRunResult[]> {
  if (options.arm !== 'cuppet' && options.arm !== 'opencode') {
    const results: HarnessRunResult[] = []
    const { sequenceFile: _sequenceFile, ...baseOptions } = options
    for (const entry of sequence) {
      const taskOptions: ArmOptions = {
        ...baseOptions,
        taskId: entry.taskId,
        promptFile: entry.promptFile,
        resultFile: entry.resultFile,
        timeoutMs: entry.timeoutMs,
      }
      results.push(await run(taskOptions, await readFile(entry.promptFile, 'utf8')))
    }
    return results
  }
  return runOpenCodeSequence(options, sequence)
}

async function runOpenCode(options: ArmOptions, prompt: string): Promise<HarnessRunResult> {
  const startedAt = new Date().toISOString()
  const started = performance.now()
  const model = toModelRef(options.model)
  const paths = await createRuntimePaths(options.workspace, options.runtimeRoot)
  const logger = new RedactedLogger(paths.logs)
  const assets = await resolveRuntimeAssets()
  let tst: TstRuntime | undefined
  let opencode: OpenCodeRuntime | undefined
  let gateway: OpenCodeGateway | undefined
  let sessionID = `${options.arm}-${options.taskId}-${Date.now()}`
  let completedTokens: TokenUsage = emptyTokenUsage()
  let cost: number | null = null
  let answer = ''
  let failure: string | undefined
  let toolCalls = 0
  let compactions = 0
  let permissionRequests = 0
  let rejectedPermissions = 0
  let eventCount = 0

  try {
    if (!assets.opencode) throw new Error(`OpenCode runtime unavailable: ${assets.diagnostics.join('; ')}`)
    if (options.arm === 'cuppet') {
      if (!assets.tst || !assets.plugin) throw new Error(`Cuppet runtime unavailable: ${assets.diagnostics.join('; ')}`)
      await seedCuppetOpenCodeProviderState(paths)
      tst = await startTstDaemon(assets.tst, paths, logger)
      await waitForIndex(tst)
    } else {
      await seedCuppetOpenCodeProviderState(paths)
    }
    const preferences = new PreferenceStore(join(process.env.HOME ?? '', '.cuppet', 'v2', 'preferences.json'))
    await preferences.load()
    opencode = await startOpenCodeServer({
      binary: assets.opencode,
      paths,
      logger,
      ...(options.arm === 'cuppet' && assets.plugin ? { plugin: assets.plugin } : {}),
      ...(options.arm === 'cuppet' && tst ? { tst: { socket: tst.socket, token: tst.token } } : {}),
      ...(preferences.value.vertexProject ? { vertexProject: preferences.value.vertexProject } : {}),
    })
    gateway = new OpenCodeGateway(opencode.client, options.workspace)
    gateway.onEvent((event: AgentEvent) => {
      eventCount += 1
      if (event.type === 'tool-start') toolCalls += 1
      if (event.type === 'compaction' && event.phase === 'ended') compactions += 1
      if (event.type === 'permission') {
        permissionRequests += 1
        const allowed = new Set([
          'read', 'edit', 'write', 'bash', 'glob', 'grep', 'lsp', 'question',
          'todowrite', 'task', 'list', 'cuppet_plan', 'cuppet_memory_search',
          'cuppet_workspace_info', 'cuppet_graph_tree', 'cuppet_graph_search', 'cuppet_graph_trace',
        ])
        const shouldAllow = allowed.has(event.request.action)
        if (!shouldAllow) rejectedPermissions += 1
        void gateway?.replyPermission(event.request.sessionID, event.request.id, shouldAllow ? 'once' : 'reject')
          .catch((error) => logger.write('warn', `benchmark permission reply failed: ${String(error)}`))
      }
      if (event.type === 'question') {
        void gateway?.rejectQuestion(event.request.id).catch((error) => logger.write('warn', `benchmark question rejection failed: ${String(error)}`))
      }
      if (event.type === 'error') failure ??= event.message
    })
    gateway.startEvents()
    const session = await gateway.createSession(model)
    sessionID = session.id
    const enriched = options.arm === 'cuppet' && tst
      ? await buildCuppetContext(tst.client, session.id, prompt, 1_048_576, [], '', options.workspace)
      : { prompt, contextTokens: 0 }
    await gateway.prompt(session.id, enriched.prompt)
    await withTimeout(gateway.wait(session.id), options.timeoutMs, `${options.arm} benchmark task timed out`)
    answer = assistantText(await gateway.messages(session.id))
    const completed = await gateway.getSession(session.id)
    completedTokens = completed.tokens
    cost = completed.cost
  } catch (error) {
    failure ??= error instanceof Error ? error.message : String(error)
    const runtimeLog = await readFile(join(paths.logs, 'cuppet.log'), 'utf8').catch(() => '')
    const diagnostic = runtimeLog.trim().split(/\r?\n/).slice(-8).join('\n')
    if (diagnostic) failure = `${failure}\n${diagnostic}`
    if (gateway && sessionID) {
      await gateway.getSession(sessionID).then((session) => {
        completedTokens = session.tokens
        cost = session.cost
      }).catch(() => undefined)
      await gateway.interrupt(sessionID).catch(() => undefined)
    }
  } finally {
    gateway?.close()
    await opencode?.close().catch(() => undefined)
    await tst?.close().catch(() => undefined)
  }

  const completedAt = new Date().toISOString()
  const success = !failure
  return {
    schema: 1,
    arm: options.arm,
    taskId: options.taskId,
    harnessVersion: OPENCODE_VERSION,
    sessionId: sessionID,
    startedAt,
    completedAt,
    durationMs: Math.round(performance.now() - started),
    success,
    attempts: 1,
    firstAttemptSuccess: success,
    retries: 0,
    usage: usageFromOpenCode(completedTokens, cost),
    toolCalls,
    compactions,
    regressions: 0,
    permissionRequests,
    rejectedPermissions,
    telemetry: { source: 'native', complete: eventCount > 0, eventCount },
    model: options.model,
    parity: parityFor(options.arm),
    finalMessage: answer,
    ...(failure ? { error: failure } : {}),
  }
}

async function runOpenCodeSequence(options: ArmOptions, sequence: SequenceEntry[]): Promise<HarnessRunResult[]> {
  const model = toModelRef(options.model)
  const paths = await createRuntimePaths(options.workspace, options.runtimeRoot)
  const logger = new RedactedLogger(paths.logs)
  const assets = await resolveRuntimeAssets()
  let tst: TstRuntime | undefined
  let opencode: OpenCodeRuntime | undefined
  let gateway: OpenCodeGateway | undefined
  let sessionID = `${options.arm}-persistent-${Date.now()}`
  let toolCalls = 0
  let compactions = 0
  let permissionRequests = 0
  let rejectedPermissions = 0
  let eventCount = 0
  let activeFailure: string | undefined
  const results: HarnessRunResult[] = []

  try {
    if (!assets.opencode) throw new Error(`OpenCode runtime unavailable: ${assets.diagnostics.join('; ')}`)
    if (options.arm === 'cuppet') {
      if (!assets.tst || !assets.plugin) throw new Error(`Cuppet runtime unavailable: ${assets.diagnostics.join('; ')}`)
      await seedCuppetOpenCodeProviderState(paths)
      tst = await startTstDaemon(assets.tst, paths, logger)
      await waitForIndex(tst)
    } else {
      await seedCuppetOpenCodeProviderState(paths)
    }
    const preferences = new PreferenceStore(join(process.env.HOME ?? '', '.cuppet', 'v2', 'preferences.json'))
    await preferences.load()
    opencode = await startOpenCodeServer({
      binary: assets.opencode,
      paths,
      logger,
      ...(options.arm === 'cuppet' && assets.plugin ? { plugin: assets.plugin } : {}),
      ...(options.arm === 'cuppet' && tst ? { tst: { socket: tst.socket, token: tst.token } } : {}),
      ...(preferences.value.vertexProject ? { vertexProject: preferences.value.vertexProject } : {}),
    })
    gateway = new OpenCodeGateway(opencode.client, options.workspace)
    gateway.onEvent((event: AgentEvent) => {
      eventCount += 1
      if (event.type === 'tool-start') toolCalls += 1
      if (event.type === 'compaction' && event.phase === 'ended') compactions += 1
      if (event.type === 'permission') {
        permissionRequests += 1
        const allowed = new Set([
          'read', 'edit', 'write', 'bash', 'glob', 'grep', 'lsp', 'question',
          'todowrite', 'task', 'list', 'cuppet_plan', 'cuppet_memory_search',
          'cuppet_workspace_info', 'cuppet_graph_tree', 'cuppet_graph_search', 'cuppet_graph_trace',
        ])
        const shouldAllow = allowed.has(event.request.action)
        if (!shouldAllow) rejectedPermissions += 1
        void gateway?.replyPermission(event.request.sessionID, event.request.id, shouldAllow ? 'once' : 'reject')
          .catch((error) => logger.write('warn', `benchmark permission reply failed: ${String(error)}`))
      }
      if (event.type === 'question') {
        void gateway?.rejectQuestion(event.request.id).catch((error) => logger.write('warn', `benchmark question rejection failed: ${String(error)}`))
      }
      if (event.type === 'error') activeFailure ??= event.message
    })
    gateway.startEvents()
    const session = await gateway.createSession(model)
    sessionID = session.id
    let previousTokens = emptyTokenUsage()
    let previousCost = 0
    let previousToolCalls = 0
    let previousCompactions = 0
    let previousEvents = 0
    let previousPermissionRequests = 0
    let previousRejectedPermissions = 0
    for (const entry of sequence) {
      const startedAt = new Date().toISOString()
      const started = performance.now()
      activeFailure = undefined
      let answer = ''
      let currentTokens = previousTokens
      let currentCost = previousCost
      try {
        const prompt = await readFile(entry.promptFile, 'utf8')
        const enriched = options.arm === 'cuppet' && tst
          ? await buildCuppetContext(tst.client, session.id, prompt, 1_048_576, [], '', options.workspace)
          : { prompt, contextTokens: 0 }
        await gateway.prompt(session.id, enriched.prompt)
        await withTimeout(gateway.wait(session.id), entry.timeoutMs, `${options.arm} persistent task ${entry.taskId} timed out`)
        answer = assistantText(await gateway.messages(session.id))
        const completed = await gateway.getSession(session.id)
        currentTokens = completed.tokens
        currentCost = completed.cost
      } catch (error) {
        activeFailure ??= error instanceof Error ? error.message : String(error)
        await gateway.interrupt(session.id).catch(() => undefined)
        await gateway.getSession(session.id).then((current) => {
          currentTokens = current.tokens
          currentCost = current.cost
        }).catch(() => undefined)
      }
      const completedAt = new Date().toISOString()
      const failure = activeFailure
      const success = !failure
      results.push({
        schema: 1,
        arm: options.arm,
        taskId: entry.taskId,
        harnessVersion: OPENCODE_VERSION,
        sessionId: sessionID,
        startedAt,
        completedAt,
        durationMs: Math.round(performance.now() - started),
        success,
        attempts: 1,
        firstAttemptSuccess: success,
        retries: 0,
        usage: usageFromOpenCode(diffTokenUsage(currentTokens, previousTokens), currentCost > previousCost ? currentCost - previousCost : null),
        toolCalls: toolCalls - previousToolCalls,
        compactions: compactions - previousCompactions,
        regressions: 0,
        permissionRequests: permissionRequests - previousPermissionRequests,
        rejectedPermissions: rejectedPermissions - previousRejectedPermissions,
        telemetry: { source: 'native', complete: eventCount > previousEvents, eventCount: eventCount - previousEvents },
        model: options.model,
        parity: parityFor(options.arm),
        finalMessage: answer,
        ...(failure ? { error: failure } : {}),
      })
      previousTokens = currentTokens
      previousCost = currentCost
      previousToolCalls = toolCalls
      previousCompactions = compactions
      previousEvents = eventCount
      previousPermissionRequests = permissionRequests
      previousRejectedPermissions = rejectedPermissions
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return sequence.map((entry) => failedResult({ ...options, taskId: entry.taskId }, message))
  } finally {
    gateway?.close()
    await opencode?.close().catch(() => undefined)
    await tst?.close().catch(() => undefined)
  }
  return results
}

function diffTokenUsage(after: TokenUsage, before: TokenUsage): TokenUsage {
  return {
    input: Math.max(0, after.input - before.input),
    output: Math.max(0, after.output - before.output),
    reasoning: Math.max(0, after.reasoning - before.reasoning),
    cacheRead: Math.max(0, after.cacheRead - before.cacheRead),
    cacheWrite: Math.max(0, after.cacheWrite - before.cacheWrite),
  }
}

async function runExternal(options: ArmOptions, prompt: string): Promise<HarnessRunResult> {
  const startedAt = new Date().toISOString()
  const started = performance.now()
  const binary = options.arm === 'codex'
    ? process.env.CUPPET_BENCHMARK_CODEX_BIN ?? 'codex'
    : process.env.CUPPET_BENCHMARK_CLAUDE_BIN ?? 'claude'
  const harnessVersion = await binaryVersion(binary)
  const processResult = await runExternalProcess(options, prompt)
  const events = parseJsonLines(processResult.stdout)
  const parsed = options.arm === 'codex' ? parseCodex(events) : parseClaude(events)
  const completedAt = new Date().toISOString()
  const error = processResult.timedOut
    ? `${options.arm} benchmark task timed out`
    : processResult.exitCode === 0
      ? undefined
      : processResult.stderr.trim() || `${options.arm} exited with code ${String(processResult.exitCode)}`
  const success = !error
  return {
    schema: 1,
    arm: options.arm,
    taskId: options.taskId,
    harnessVersion,
    sessionId: parsed.sessionId || `${options.arm}-${options.taskId}-${Date.now()}`,
    startedAt,
    completedAt,
    durationMs: Math.round(performance.now() - started),
    success,
    attempts: 1,
    firstAttemptSuccess: success,
    retries: 0,
    usage: parsed.usage,
    toolCalls: parsed.toolCalls,
    compactions: parsed.compactions,
    regressions: 0,
    permissionRequests: 0,
    rejectedPermissions: 0,
    telemetry: {
      source: options.arm === 'codex' ? 'codex-jsonl' : 'claude-stream-json',
      complete: events.length > 0,
      eventCount: events.length,
    },
    model: options.model,
    parity: parityFor(options.arm),
    finalMessage: parsed.finalMessage,
    ...(error ? { error } : {}),
  }
}

async function binaryVersion(binary: string): Promise<string> {
  try {
    const result = await execFile(binary, ['--version'], { maxBuffer: 64 * 1024 })
    return result.stdout.trim() || result.stderr.trim() || 'unavailable'
  } catch {
    return 'unavailable'
  }
}

async function runExternalProcess(options: ArmOptions, prompt: string): Promise<ProcessResult> {
  const binary = options.arm === 'codex'
    ? process.env.CUPPET_BENCHMARK_CODEX_BIN ?? 'codex'
    : process.env.CUPPET_BENCHMARK_CLAUDE_BIN ?? 'claude'
  const args = options.arm === 'codex'
    ? [
        'exec', '--json', '--ephemeral', '--skip-git-repo-check',
        '--model', options.model.model,
        '--cd', options.workspace,
        '--approve-for-me',
        '-c', `model_reasoning_effort=${JSON.stringify(options.model.reasoningEffort)}`,
        '-',
      ]
    : [
        '--print', '--output-format', 'stream-json', '--verbose',
        '--no-session-persistence', '--permission-mode', 'bypassPermissions',
        '--model', options.model.model,
        '--effort', options.model.reasoningEffort,
        '--add-dir', options.workspace,
      ]
  const child = spawn(binary, args, {
    cwd: options.workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(options.arm === 'codex' ? { CODEX_BENCHMARK_RUN: '1' } : { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }),
    },
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  child.stdin.end(prompt)
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }, 1_500).unref()
  }, options.timeoutMs)
  const started = performance.now()
  const exitCode = await new Promise<number | string>((resolveExit) => {
    child.once('error', (error) => resolveExit(error.message))
    child.once('close', (code, signal) => resolveExit(code ?? signal ?? 'unknown'))
  })
  clearTimeout(timeout)
  return {
    exitCode,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    durationMs: Math.round(performance.now() - started),
    timedOut,
  }
}

function parseCodex(events: Array<Record<string, unknown>>): ParsedExternalResult {
  const usage = lastUsage(events)
  const finalMessage = findString(events, (event) => {
    const item = record(event.item)
    return item?.type === 'agent_message' ? stringValue(item.text ?? item.message) : undefined
  }) ?? ''
  const sessionId = events.map((event) => stringValue(event.thread_id ?? event.session_id)).find(Boolean) ?? ''
  const toolCalls = events.filter((event) => {
    const item = record(event.item)
    return event.type === 'item.started' && Boolean(item && ['command_execution', 'file_change', 'mcp_tool_call', 'web_search_call'].includes(stringValue(item.type)))
  }).length
  return {
    sessionId,
    finalMessage,
    toolCalls,
    compactions: events.filter((event) => String(event.type).includes('compaction')).length,
    usage: usageFromExternal(usage),
  }
}

function parseClaude(events: Array<Record<string, unknown>>): ParsedExternalResult {
  const result = [...events].reverse().find((event) => event.type === 'result')
  const usage = record(result?.usage) ?? lastUsage(events)
  const sessionId = (stringValue(result?.session_id ?? result?.sessionId) || events.map((event) => stringValue(event.session_id)).find(Boolean)) ?? ''
  const finalMessage = (stringValue(result?.result) || findString(events, (event) => {
    const message = record(event.message)
    return message?.role === 'assistant' ? stringValue(message.content) : undefined
  })) ?? ''
  const toolCalls = events.reduce((total, event) => {
    const message = record(event.message)
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return total
    return total + message.content.filter((item) => record(item)?.type === 'tool_use').length
  }, 0)
  return {
    sessionId,
    finalMessage,
    toolCalls,
    compactions: events.filter((event) => event.type === 'system' && String(event.subtype ?? '').includes('compact')).length,
    usage: usageFromExternal(usage),
  }
}

type ParsedExternalResult = {
  sessionId: string
  finalMessage: string
  toolCalls: number
  compactions: number
  usage: UsageTotals
}

function usageFromExternal(usage: Record<string, unknown> | undefined): UsageTotals {
  const inputTokens = numberValue(usage?.input_tokens ?? usage?.inputTokens ?? usage?.prompt_tokens)
  const cachedInputTokens = numberValue(usage?.cached_input_tokens ?? usage?.cache_read_input_tokens ?? usage?.cacheReadTokens)
  const outputTokens = numberValue(usage?.output_tokens ?? usage?.outputTokens ?? usage?.completion_tokens)
  const reasoningTokens = numberValue(usage?.reasoning_output_tokens ?? usage?.reasoning_tokens ?? usage?.reasoningTokens)
  const cost = usage?.total_cost_usd ?? usage?.cost
  return {
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens),
    outputTokens,
    reasoningTokens,
    // OpenCode's session input counter excludes cache reads. Normalize the
    // cross-harness headline metric to the same uncached-input basis while
    // retaining the provider's raw input and cache counters separately.
    totalModelTokens: Math.max(0, inputTokens - cachedInputTokens) + outputTokens + reasoningTokens,
    effectiveCost: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
  }
}

function usageFromOpenCode(tokens: TokenUsage, cost: number | null): UsageTotals {
  return {
    inputTokens: tokens.input,
    cachedInputTokens: tokens.cacheRead,
    uncachedInputTokens: tokens.input,
    outputTokens: tokens.output,
    reasoningTokens: tokens.reasoning,
    totalModelTokens: tokens.input + tokens.output + tokens.reasoning,
    effectiveCost: cost !== null && cost > 0 ? cost : null,
  }
}

function lastUsage(events: Array<Record<string, unknown>>): Record<string, unknown> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const usage = record(events[index]?.usage)
    if (usage) return usage
  }
  return undefined
}

function findString(events: Array<Record<string, unknown>>, find: (event: Record<string, unknown>) => string | undefined): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const value = find(events[index]!)
    if (value) return value
  }
  return undefined
}

function parseJsonLines(value: string): Array<Record<string, unknown>> {
  return value.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      const parsed: unknown = JSON.parse(line)
      return [record(parsed)].filter((item): item is Record<string, unknown> => item !== undefined)
    } catch {
      return []
    }
  })
}

function parityFor(arm: HarnessID): HarnessRunResult['parity'] {
  if (arm === 'claude-code') return {
    status: 'product-comparison',
    notes: 'Claude Code does not expose the configured Luna model; compare as a complete product arm, not exact model parity.',
  }
  if (arm === 'codex') return {
    status: 'exact',
    notes: 'Codex receives the manifest model and low reasoning setting through its native exec flags.',
  }
  return {
    status: 'exact',
    notes: arm === 'cuppet'
      ? `Cuppet uses the configured model and ${OPENCODE_VERSION} derivative runtime.`
      : `OpenCode uses the configured model and ${OPENCODE_VERSION} kernel runtime.`,
  }
}

function toModelRef(model: ModelSpec): ModelRef {
  return {
    providerID: model.provider,
    modelID: model.model,
    variant: model.reasoningEffort,
  }
}

function emptyUsage(): UsageTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    uncachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalModelTokens: 0,
    effectiveCost: null,
  }
}

function emptyTokenUsage(): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function waitForIndex(runtime: TstRuntime): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const status = await runtime.client.call<{ graph?: { progress?: { complete?: boolean } } }>('status')
    if (status.graph?.progress?.complete) return
    await delay(100)
  }
  throw new Error('benchmark TST index did not complete')
}

function assistantText(messages: unknown[]): string {
  return messages.map((message) => {
    const info = record(record(message)?.info)
    if (info?.role !== 'assistant') return ''
    const parts = Array.isArray(record(message)?.parts) ? record(message)?.parts as unknown[] : []
    return parts.map((part) => {
      const value = record(part)
      return value?.type === 'text' ? stringValue(value.text) : ''
    }).join('')
  }).filter(Boolean).join('\n')
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function parseArgs(argv: string[]): ArmOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key?.startsWith('--')) continue
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${key} requires a value`)
    values.set(key.slice(2), value)
    index += 1
  }
  const arm = values.get('arm')
  if (arm !== 'cuppet' && arm !== 'opencode' && arm !== 'codex' && arm !== 'claude-code') throw new Error('invalid --arm')
  const required = ['workspace', 'prompt-file', 'result-file', 'runtime-root', 'task-id', 'model', 'provider', 'reasoning-effort', 'timeout-ms', 'session-mode']
  for (const key of required) if (!values.get(key)) throw new Error(`missing --${key}`)
  const sessionMode = values.get('session-mode')
  if (sessionMode !== 'isolated' && sessionMode !== 'persistent') throw new Error('invalid --session-mode')
  return {
    arm,
    workspace: resolve(values.get('workspace')!),
    promptFile: resolve(values.get('prompt-file')!),
    resultFile: resolve(values.get('result-file')!),
    runtimeRoot: resolve(values.get('runtime-root')!),
    taskId: values.get('task-id')!,
    model: {
      provider: values.get('provider')!,
      model: values.get('model')!,
      reasoningEffort: values.get('reasoning-effort')!,
    },
    timeoutMs: Number(values.get('timeout-ms')),
    sessionMode,
    ...(values.get('sequence-file') ? { sequenceFile: resolve(values.get('sequence-file')!) } : {}),
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}
