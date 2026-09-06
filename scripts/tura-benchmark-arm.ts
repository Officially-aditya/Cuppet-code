import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import type {
  HarnessRunResult,
  ModelSpec,
  UsageTotals,
  VerificationResult,
  VerificationSpec,
} from './lib/benchmark-contract.js'

type SequenceEntry = {
  taskId: string
  promptFile: string
  resultFile: string
  timeoutMs: number
  verification?: VerificationSpec[]
}

type TuraOptions = {
  workspace: string
  promptFile: string
  resultFile: string
  runtimeRoot: string
  taskId: string
  model: ModelSpec
  timeoutMs: number
  sessionMode: 'isolated' | 'persistent'
  sequenceFile: string
}

type ProcessResult = {
  exitCode: number | string
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

const options = parseArgs(process.argv.slice(2))
const sequence = JSON.parse(await readFile(options.sequenceFile, 'utf8')) as SequenceEntry[]
const sessionID = `tura-direct-${createHash('sha256').update(resolve(options.workspace)).digest('hex').slice(0, 20)}`
const harnessVersion = process.env.CUPPET_TURA_VERSION?.trim() || 'unreported'
const results: HarnessRunResult[] = []

for (const entry of sequence) {
  const result = await runTurn(options, entry, sessionID, harnessVersion)
  results.push(result)
  await writeFile(entry.resultFile, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  if (!result.success) break
}

process.stdout.write(`${JSON.stringify({ arm: 'tura-direct', sequence: results.map((result) => ({ taskId: result.taskId, success: result.success, sessionId: result.sessionId })) })}\n`)
if (results.some((result) => !result.success) || results.length !== sequence.length) process.exitCode = 1

async function runTurn(
  options: TuraOptions,
  entry: SequenceEntry,
  sessionID: string,
  harnessVersion: string,
): Promise<HarnessRunResult> {
  const startedAt = new Date().toISOString()
  const started = performance.now()
  const prompt = await readFile(entry.promptFile, 'utf8')
  const binary = process.env.CUPPET_TURA_BIN?.trim() || 'tura'
  const args = [
    'exec',
    '--cwd', options.workspace,
    '--agent-id', 'direct',
    '--model', `${options.model.provider}/${options.model.model}`,
    '--model-reasoning-effort', options.model.reasoningEffort,
    '--session-id', sessionID,
    '--json',
    '--log',
    '--sandbox',
  ]
  const execution = await runProcess(binary, args, options.workspace, prompt, options.timeoutMs)
  await writeFile(`${entry.resultFile}.tura.stdout.ndjson`, execution.stdout, 'utf8')
  await writeFile(`${entry.resultFile}.tura.stderr.log`, execution.stderr, 'utf8')
  const events = parseJsonLines(execution.stdout)
  const turnLog = parseTurnLog(execution.stderr)
  const completed = [...events].reverse().find((event) => event.type === 'turn.completed')
  const usage = usageFrom(turnLog?.usage ?? record(completed?.usage))
  const finalMessage = findFinalMessage(events)
  const resolvedMetadata = record(completed?.metadata)
  const resolvedModel = stringValue(completed?.model ?? resolvedMetadata?.model)
  const resolvedEffort = stringValue(completed?.reasoning_effort ?? resolvedMetadata?.reasoning_effort)
  const modelMismatch = (resolvedModel && resolvedModel !== `${options.model.provider}/${options.model.model}`)
    || (resolvedEffort && resolvedEffort !== options.model.reasoningEffort)
  const providerError = findTuraError(events, execution.stderr)
  const executionFailure = execution.timedOut
    ? 'timeout'
    : execution.exitCode === 0
      ? undefined
      : providerError || `tura exited with code ${String(execution.exitCode)}`
  const error = modelMismatch
    ? `model resolution mismatch: resolved model=${resolvedModel || 'unreported'} reasoning=${resolvedEffort || 'unreported'}`
    : executionFailure
  const success = !error && Boolean(completed) && (completed?.status === undefined || completed.status === 'completed')
  const toolCalls = turnLog?.tool_calls?.length ?? events.filter((event) => event.type === 'item.completed' && isToolItem(record(event.item)?.type)).length
  const compactions = events.filter((event) => String(event.type).toLowerCase().includes('compact')).length
  const verification = await runTuraVerifiers(options.workspace, entry.verification ?? [])
  return {
    schema: 1,
    arm: 'tura-direct',
    taskId: entry.taskId,
    harnessVersion,
    sessionId: sessionID,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    success,
    attempts: 1,
    firstAttemptSuccess: success,
    retries: 0,
    usage,
    toolCalls,
    compactions,
    regressions: 0,
    permissionRequests: 0,
    rejectedPermissions: 0,
    telemetry: { source: 'tura-jsonl', complete: Boolean(completed), eventCount: events.length },
    model: options.model,
    parity: {
      status: 'exact',
      notes: 'Tura Direct native exec session with explicit openai/gpt-5.6-luna and low reasoning settings; no Cuppet context injected.',
    },
    finalMessage,
    ...(verification.length > 0 ? { verification } : {}),
    ...(error ? { error } : {}),
  }
}

async function runTuraVerifiers(workspace: string, specs: VerificationSpec[]): Promise<VerificationResult[]> {
  return Promise.all(specs.map(async (spec) => {
    const started = performance.now()
    const execution = await runVerifierProcess(spec.command, spec.args, workspace, spec.timeoutMs)
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

async function runVerifierProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  let timedOut = false
  const started = performance.now()
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 1_500).unref()
  }, timeoutMs)
  const exitCode = await new Promise<number | string>((resolveExit) => {
    let settled = false
    const settle = (value: number | string) => { if (!settled) { settled = true; resolveExit(value) } }
    child.once('error', (error) => settle(error.message))
    child.once('close', (code, signal) => settle(code ?? signal ?? 'unknown'))
  })
  clearTimeout(timer)
  return { exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), durationMs: Math.round(performance.now() - started), timedOut }
}

async function runProcess(command: string, args: string[], cwd: string, input: string, timeoutMs: number): Promise<ProcessResult> {
  const child = spawn(command, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  child.stdin.end(input)
  let timedOut = false
  const started = performance.now()
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 1_500).unref()
  }, timeoutMs)
  const exitCode = await new Promise<number | string>((resolveExit) => {
    let settled = false
    const settle = (value: number | string) => { if (!settled) { settled = true; resolveExit(value) } }
    child.once('error', (error) => settle(error.message))
    child.once('close', (code, signal) => settle(code ?? signal ?? 'unknown'))
  })
  clearTimeout(timer)
  return { exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), durationMs: Math.round(performance.now() - started), timedOut }
}

function parseJsonLines(value: string): Array<Record<string, unknown>> {
  return value.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try { const parsed = JSON.parse(line); return [record(parsed)].filter((item): item is Record<string, unknown> => item !== undefined) } catch { return [] }
  })
}

function parseTurnLog(stderr: string): { usage?: Record<string, unknown>; tool_calls?: unknown[] } | undefined {
  const line = stderr.split(/\r?\n/).find((candidate) => candidate.startsWith('TURA_TURN_LOG '))
  if (!line) return undefined
  try { return JSON.parse(line.slice('TURA_TURN_LOG '.length)) as { usage?: Record<string, unknown>; tool_calls?: unknown[] } } catch { return undefined }
}

function usageFrom(usage: Record<string, unknown> | undefined): UsageTotals {
  const inputTokens = numberValue(usage?.input_tokens)
  const cachedInputTokens = numberValue(usage?.cached_input_tokens)
  const outputTokens = numberValue(usage?.output_tokens)
  const reasoningTokens = numberValue(usage?.reasoning_tokens ?? usage?.reasoning_output_tokens)
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens)
  return { inputTokens, cachedInputTokens, uncachedInputTokens, outputTokens, reasoningTokens, totalModelTokens: uncachedInputTokens + outputTokens + reasoningTokens, effectiveCost: null }
}

function findFinalMessage(events: Array<Record<string, unknown>>): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    const item = record(event.item)
    if (item && (item.type === 'agent_message' || item.type === 'assistant_message')) return stringValue(item.text)
  }
  return ''
}

function findTuraError(events: Array<Record<string, unknown>>, stderr: string): string | undefined {
  const event = events.find((candidate) => candidate.type === 'error' || candidate.status === 'failed')
  return stringValue(event?.error ?? event?.message) || (stderr.match(/(?:error|failed|rate[_ -]?limit|quota)[^\n]*/i)?.[0])
}

function isToolItem(value: unknown): boolean {
  return value === 'command_execution' || value === 'file_change' || value === 'mcp_tool_call' || value === 'web_search_call'
}

function numberValue(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0 }
function stringValue(value: unknown): string { return typeof value === 'string' ? value : '' }
function record(value: unknown): Record<string, any> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined }
function truncate(value: string): string { return value.length > 12_000 ? `${value.slice(0, 12_000)}\n…<truncated>` : value }

function parseArgs(argv: string[]): TuraOptions {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error('invalid Tura arm arguments')
    values.set(key.slice(2), value)
    index += 1
  }
  const required = ['workspace', 'prompt-file', 'result-file', 'runtime-root', 'task-id', 'model', 'provider', 'reasoning-effort', 'timeout-ms', 'session-mode', 'sequence-file']
  for (const key of required) if (!values.get(key)) throw new Error(`missing --${key}`)
  const sessionMode = values.get('session-mode')
  if (sessionMode !== 'persistent') throw new Error('Tura Direct requires persistent session mode')
  return {
    workspace: resolve(values.get('workspace')!),
    promptFile: resolve(values.get('prompt-file')!),
    resultFile: resolve(values.get('result-file')!),
    runtimeRoot: resolve(values.get('runtime-root')!),
    taskId: values.get('task-id')!,
    model: { provider: values.get('provider')!, model: values.get('model')!, reasoningEffort: values.get('reasoning-effort')! },
    timeoutMs: Number(values.get('timeout-ms')),
    sessionMode,
    sequenceFile: resolve(values.get('sequence-file')!),
  }
}
