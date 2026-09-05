import { execFile as execFileCallback, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  expandCommandArgs,
  freezeManifest,
  sha256Text,
  summarizeArmResults,
  type BenchmarkArm,
  type BenchmarkManifest,
  type BenchmarkReport,
  type BenchmarkTask,
  type FrozenManifest,
  type HarnessID,
  type HarnessRunResult,
  type PlaceholderValues,
  type TaskRunResult,
  type VerificationResult,
} from './lib/benchmark-contract.js'

type RunnerOptions = {
  manifestPath: string
  outputDirectory: string
  dryRun: boolean
  keepWorkspaces: boolean
  repeats?: number
  arms?: Set<HarnessID>
  tasks?: Set<string>
}

type ProcessExecution = {
  exitCode: number | string
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

const execFile = promisify(execFileCallback)
const project = resolve(process.cwd())

await main().catch((error) => {
  process.stderr.write(`Benchmark runner failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const manifestPath = resolve(project, options.manifestPath)
  const manifest = await loadManifest(manifestPath)
  const repoRoot = resolve(project, manifest.repository.path)
  const actualRoot = await git(repoRoot, ['rev-parse', '--show-toplevel'])
  if (resolve(actualRoot) !== resolve(repoRoot)) throw new Error(`manifest repository path is not a Git root: ${repoRoot}`)
  const resolvedSha = await git(repoRoot, ['rev-parse', `${manifest.repository.startingSha}^{commit}`])
  const selected = selectManifest(manifest, options)
  const frozen = freezeManifest(selected, resolvedSha, environmentSnapshot())

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ manifest: frozen, schedule: schedule(frozen) }, null, 2)}\n`)
    return
  }

  const outputDirectory = resolve(repoRoot, options.outputDirectory)
  await mkdir(outputDirectory, { recursive: true })
  const runRoot = await mkdtemp(join(repoRoot, '.benchmarks', `${safeName(frozen.name)}-`))
  await mkdir(join(runRoot, 'prompts'), { recursive: true })
  await mkdir(join(runRoot, 'logs'), { recursive: true })
  await writeFile(join(runRoot, 'manifest.json'), `${JSON.stringify(frozen, null, 2)}\n`, 'utf8')

  const createdAt = new Date().toISOString()
  const taskResults = await executeBenchmark(frozen, repoRoot, runRoot, options)
  const summaries = frozen.arms.filter((arm) => arm.enabled).map((arm) => summarizeArmResults(arm.id, taskResults))
  const report: BenchmarkReport = {
    schema: 1,
    status: taskResults.every((result) => result.success) ? 'completed' : 'failed',
    createdAt,
    completedAt: new Date().toISOString(),
    manifest: frozen,
    runRoot,
    taskResults,
    summaries,
    notes: [
      'The controller freezes the repository SHA, task prompts, model settings, harness metadata, environment allowlist, and verifier commands before the first arm runs.',
      'The controller only runs deterministic verification commands; it does not rewrite prompts, coach harnesses, or make subjective correctness judgments.',
      'Failed tasks retain all telemetry emitted before failure. A null cost means the harness did not expose provider-adjusted pricing.',
      'Persistent Cuppet/OpenCode sequences reuse one native session; Codex and Claude Code persistent-family entries currently run sequential native CLI turns because their resume/session telemetry is not yet reliable enough to claim a single persistent session.',
      ...frozen.arms.filter((arm) => arm.enabled && arm.model.parity !== 'exact').map((arm) => `${arm.id}: ${arm.model.notes}`),
    ],
  }
  const stamp = new Date().toISOString().replaceAll(':', '-')
  const jsonPath = join(outputDirectory, `benchmark-${safeName(frozen.name)}-${stamp}.json`)
  const markdownPath = join(outputDirectory, `benchmark-${safeName(frozen.name)}-${stamp}.md`)
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(markdownPath, renderMarkdown(report), 'utf8')
  process.stdout.write(`${JSON.stringify({ status: report.status, summaries, jsonPath, markdownPath }, null, 2)}\n`)
}

async function executeBenchmark(
  manifest: FrozenManifest,
  repoRoot: string,
  runRoot: string,
  options: RunnerOptions,
): Promise<TaskRunResult[]> {
  const enabledArms = manifest.arms.filter((arm) => arm.enabled)
  const taskResults: TaskRunResult[] = []
  const promptFiles = new Map<string, string>()

  for (let repeat = 1; repeat <= manifest.repetitions; repeat += 1) {
    let persistentSequenceRun = false
    for (let taskIndex = 0; taskIndex < manifest.taskSet.tasks.length; taskIndex += 1) {
      const task = manifest.taskSet.tasks[taskIndex]!
      if (task.sessionMode === 'persistent') {
        if (persistentSequenceRun) continue
        persistentSequenceRun = true
        const persistentTasks = manifest.taskSet.tasks.filter((candidate) => candidate.sessionMode === 'persistent')
        const arms = orderedArms(enabledArms, manifest.ordering, repeat, taskIndex)
        for (const arm of arms) {
          for (const candidate of persistentTasks) {
            if (!promptFiles.has(candidate.id)) {
              const promptFile = join(runRoot, 'prompts', `${safeName(candidate.id)}.txt`)
              await writeFile(promptFile, candidate.prompt, 'utf8')
              promptFiles.set(candidate.id, promptFile)
            }
          }
          const results = await executePersistentSequence({
            manifest,
            arm,
            tasks: persistentTasks,
            repeat,
            workRoot: join(runRoot, 'workspaces'),
            promptFiles,
            repoRoot,
            runRoot,
            keepWorkspace: options.keepWorkspaces,
          })
          taskResults.push(...results)
        }
        continue
      }
      const arms = orderedArms(enabledArms, manifest.ordering, repeat, taskIndex)
      for (const arm of arms) {
        const workspace = join(runRoot, 'workspaces', safeName(`repeat-${repeat}-${task.id}-${arm.id}`))
        await prepareWorkspace(repoRoot, manifest.repository.resolvedSha, workspace, manifest.workspace.dependencyMode)
        let promptFile = promptFiles.get(task.id)
        if (!promptFile) {
          promptFile = join(runRoot, 'prompts', `${safeName(task.id)}.txt`)
          await writeFile(promptFile, task.prompt, 'utf8')
          promptFiles.set(task.id, promptFile)
        }
        const result = await executeTask({
          manifest,
          arm,
          task,
          repeat,
          taskIndex,
          workspace,
          promptFile,
          repoRoot,
          runRoot,
        })
        const reportWorkspace = options.keepWorkspaces ? workspace : '<removed after evaluation>'
        taskResults.push({ ...result, workspace: reportWorkspace })
        if (!options.keepWorkspaces && task.sessionMode === 'isolated') {
          await rm(workspace, { recursive: true, force: true })
        }
      }
    }
  }
  return taskResults
}

async function executePersistentSequence(options: {
  manifest: FrozenManifest
  arm: BenchmarkArm
  tasks: BenchmarkTask[]
  repeat: number
  workRoot: string
  promptFiles: Map<string, string>
  repoRoot: string
  runRoot: string
  keepWorkspace: boolean
}): Promise<TaskRunResult[]> {
  const workspace = join(options.workRoot, safeName(`repeat-${options.repeat}-${options.arm.id}-persistent`))
  await prepareWorkspace(options.repoRoot, options.manifest.repository.resolvedSha, workspace, options.manifest.workspace.dependencyMode)
  const runtimeBase = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
  const runtimeRoot = await mkdtemp(join(runtimeBase, 'cuppet-bench-runtime-'))
  const sequenceFile = join(options.runRoot, 'prompts', `repeat-${options.repeat}-${options.arm.id}-persistent.json`)
  const entries = options.tasks.map((task) => ({
    taskId: task.id,
    promptFile: options.promptFiles.get(task.id)!,
    resultFile: join(options.runRoot, 'results', `repeat-${options.repeat}-${safeName(task.id)}-${options.arm.id}.json`),
    timeoutMs: options.manifest.workspace.timeoutMs,
  }))
  await mkdir(dirname(entries[0]!.resultFile), { recursive: true })
  await writeFile(sequenceFile, `${JSON.stringify(entries, null, 2)}\n`, 'utf8')
  const first = options.tasks[0]!
  const firstPromptFile = options.promptFiles.get(first.id)!
  const firstResultFile = entries[0]!.resultFile
  const values: PlaceholderValues = {
    arm: options.arm.id,
    controllerRoot: options.repoRoot,
    workspace,
    promptFile: firstPromptFile,
    resultFile: firstResultFile,
    sequenceFile,
    runtimeRoot,
    taskId: first.id,
    repeat: String(options.repeat),
    model: options.arm.model.model,
    provider: options.arm.model.provider,
    reasoningEffort: options.arm.model.reasoningEffort,
    timeoutMs: String(options.manifest.workspace.timeoutMs),
    sessionMode: 'persistent',
  }
  const args = [...expandCommandArgs(options.arm.command.args, values), '--sequence-file', sequenceFile]
  const env = expandEnvironment(options.arm.command.env, values)
  const execution = await runCommand(options.arm.command.command, args, workspace, {
    env,
    timeoutMs: options.manifest.workspace.timeoutMs * options.tasks.length,
  })
  await writeFile(join(options.runRoot, 'logs', `persistent-${options.arm.id}-${options.repeat}.stdout.log`), execution.stdout, 'utf8')
  await writeFile(join(options.runRoot, 'logs', `persistent-${options.arm.id}-${options.repeat}.stderr.log`), execution.stderr, 'utf8')
  const results: TaskRunResult[] = []
  for (const [index, task] of options.tasks.entries()) {
    const entry = entries[index]!
    const taskValues: PlaceholderValues = { ...values, taskId: task.id, promptFile: entry.promptFile, resultFile: entry.resultFile }
    const run = await readHarnessResult(entry.resultFile, options.arm, task.id, options.manifest.model, execution)
    const verification = await Promise.all(task.verification.map((spec) => runVerification(spec, {
      manifest: options.manifest,
      arm: options.arm,
      task,
      repeat: options.repeat,
      taskIndex: index,
      workspace,
      promptFile: entry.promptFile,
      repoRoot: options.repoRoot,
      runRoot: options.runRoot,
    }, taskValues)))
    const passedChecks = verification.filter((check) => check.passed).length
    const acceptanceScore = verification.length > 0 ? passedChecks / verification.length : 0
    const changedFiles = await changedFilesIn(workspace)
    const gitDiffStat = await git(workspace, ['diff', '--stat']).catch(() => '')
    const success = run.success && execution.exitCode === 0 && !execution.timedOut && verification.every((check) => check.passed)
    const error = success
      ? undefined
      : run.error
        ?? (execution.timedOut ? 'persistent harness process timed out' : execution.exitCode === 0 ? undefined : execution.stderr.trim() || `persistent harness exited with ${String(execution.exitCode)}`)
        ?? verification.find((check) => !check.passed)?.stderr.trim()
        ?? 'deterministic verification failed'
    const normalizedRun: HarnessRunResult = {
      ...run,
      parity: { status: options.arm.model.parity, notes: options.arm.model.notes },
      model: {
        provider: options.arm.model.provider,
        model: options.arm.model.model,
        reasoningEffort: options.arm.model.reasoningEffort,
      },
      ...(error && !run.error ? { error } : {}),
    }
    results.push({
      arm: options.arm.id,
      taskId: task.id,
      repeat: options.repeat,
      sessionMode: 'persistent',
      workspace: options.keepWorkspace ? workspace : '<removed after evaluation>',
      promptSha256: sha256Text(task.prompt),
      run: normalizedRun,
      verification,
      acceptanceScore,
      success,
      changedFiles,
      gitDiffStat,
      completedAt: new Date().toISOString(),
      ...(error ? { error } : {}),
    })
  }
  await rm(runtimeRoot, { recursive: true, force: true })
  if (!options.keepWorkspace) await rm(workspace, { recursive: true, force: true })
  return results
}

async function executeTask(options: {
  manifest: FrozenManifest
  arm: BenchmarkArm
  task: BenchmarkTask
  repeat: number
  taskIndex: number
  workspace: string
  promptFile: string
  repoRoot: string
  runRoot: string
}): Promise<TaskRunResult> {
  const resultFile = join(options.runRoot, 'results', `repeat-${options.repeat}-${safeName(options.task.id)}-${options.arm.id}.json`)
  // TST uses a Unix-domain socket whose path is limited by SUN_LEN. Keep the
  // runtime base deliberately short even when the report/workspace root is
  // nested inside a long checkout path.
  const runtimeBase = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
  const runtimeRoot = await mkdtemp(join(runtimeBase, 'cuppet-bench-runtime-'))
  await mkdir(dirname(resultFile), { recursive: true })
  const values: PlaceholderValues = {
    arm: options.arm.id,
    controllerRoot: options.repoRoot,
    workspace: options.workspace,
    promptFile: options.promptFile,
    resultFile,
    sequenceFile: '',
    runtimeRoot,
    taskId: options.task.id,
    repeat: String(options.repeat),
    model: options.arm.model.model,
    provider: options.arm.model.provider,
    reasoningEffort: options.arm.model.reasoningEffort,
    timeoutMs: String(options.manifest.workspace.timeoutMs),
    sessionMode: options.task.sessionMode,
  }
  const args = expandCommandArgs(options.arm.command.args, values)
  const env = expandEnvironment(options.arm.command.env, values)
  const commandOptions: { timeoutMs: number; env?: Record<string, string>; stdin?: string } = {
    env,
    timeoutMs: options.manifest.workspace.timeoutMs,
  }
  if (options.arm.command.stdin) commandOptions.stdin = options.task.prompt
  const execution = await runCommand(options.arm.command.command, args, options.workspace, commandOptions)
  await writeFile(join(options.runRoot, 'logs', `${safeName(options.task.id)}-${options.arm.id}-${options.repeat}.stdout.log`), execution.stdout, 'utf8')
  await writeFile(join(options.runRoot, 'logs', `${safeName(options.task.id)}-${options.arm.id}-${options.repeat}.stderr.log`), execution.stderr, 'utf8')
  const run = await readHarnessResult(resultFile, options.arm, options.task.id, options.manifest.model, execution)
  const verification = await Promise.all(options.task.verification.map((spec) => runVerification(spec, options, values)))
  const passedChecks = verification.filter((check) => check.passed).length
  const acceptanceScore = verification.length > 0 ? passedChecks / verification.length : 0
  const changedFiles = await changedFilesIn(workspaceOrThrow(options.workspace))
  const gitDiffStat = await git(options.workspace, ['diff', '--stat']).catch(() => '')
  const success = run.success && execution.exitCode === 0 && !execution.timedOut && verification.every((check) => check.passed)
  const error = success
    ? undefined
    : run.error
      ?? (execution.timedOut ? 'harness process timed out' : execution.exitCode === 0 ? undefined : execution.stderr.trim() || `harness exited with ${String(execution.exitCode)}`)
      ?? verification.find((check) => !check.passed)?.stderr.trim()
      ?? 'deterministic verification failed'
  const runWithMetadata: HarnessRunResult = {
    ...run,
    parity: { status: options.arm.model.parity, notes: options.arm.model.notes },
    model: {
      provider: options.arm.model.provider,
      model: options.arm.model.model,
      reasoningEffort: options.arm.model.reasoningEffort,
    },
  }
  const normalizedRun: HarnessRunResult = error && !runWithMetadata.error
    ? { ...runWithMetadata, error }
    : runWithMetadata
  await rm(runtimeRoot, { recursive: true, force: true })
  return {
    arm: options.arm.id,
    taskId: options.task.id,
    repeat: options.repeat,
    sessionMode: options.task.sessionMode,
    workspace: options.workspace,
    promptSha256: sha256Text(options.task.prompt),
    run: normalizedRun,
    verification,
    acceptanceScore,
    success,
    changedFiles,
    gitDiffStat,
    completedAt: new Date().toISOString(),
    ...(error ? { error } : {}),
  }
}

async function runVerification(
  spec: BenchmarkTask['verification'][number],
  options: Parameters<typeof executeTask>[0],
  values: PlaceholderValues,
): Promise<VerificationResult> {
  const started = performance.now()
  const args = expandCommandArgs(spec.args, values)
  const execution = await runCommand(spec.command, args, options.workspace, { timeoutMs: spec.timeoutMs })
  const expected = spec.expectedExitCode ?? 0
  return {
    id: spec.id,
    command: spec.command,
    args,
    passed: execution.exitCode === expected && !execution.timedOut,
    exitCode: execution.exitCode,
    stdout: truncate(execution.stdout),
    stderr: truncate(execution.stderr),
    durationMs: Math.round(performance.now() - started),
  }
}

async function readHarnessResult(
  resultFile: string,
  arm: BenchmarkArm,
  taskId: string,
  model: FrozenManifest['model'],
  execution: ProcessExecution,
): Promise<HarnessRunResult> {
  try {
    const value = JSON.parse(await readFile(resultFile, 'utf8')) as HarnessRunResult
    if (value.schema !== 1 || value.arm !== arm.id || value.taskId !== taskId) throw new Error('result contract identity does not match the scheduled arm/task')
    return value
  } catch (error) {
    const completedAt = new Date().toISOString()
    return {
      schema: 1,
      arm: arm.id,
      taskId,
      harnessVersion: arm.harnessVersion,
      sessionId: `${arm.id}-${taskId}-${Date.now()}`,
      startedAt: completedAt,
      completedAt,
      durationMs: execution.durationMs,
      success: false,
      attempts: 1,
      firstAttemptSuccess: false,
      retries: 0,
      usage: {
        inputTokens: 0,
        cachedInputTokens: 0,
        uncachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalModelTokens: 0,
        effectiveCost: null,
      },
      toolCalls: 0,
      compactions: 0,
      regressions: 0,
      permissionRequests: 0,
      rejectedPermissions: 0,
      telemetry: { source: 'unavailable', complete: false, eventCount: 0 },
      model,
      parity: { status: arm.model.parity, notes: arm.model.notes },
      finalMessage: '',
      error: `harness result unavailable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function prepareWorkspace(
  repoRoot: string,
  startingSha: string,
  workspace: string,
  dependencyMode: BenchmarkManifest['workspace']['dependencyMode'],
): Promise<void> {
  await mkdir(workspace, { recursive: true })
  const archive = `${workspace}.tar`
  await execFile('git', ['archive', '--format=tar', '--output', archive, startingSha], { cwd: repoRoot })
  await execFile('tar', ['-xf', archive, '-C', workspace])
  await rm(archive, { force: true })
  await execFile('git', ['init', '--quiet'], { cwd: workspace })
  await execFile('git', ['config', 'user.email', 'benchmark@localhost'], { cwd: workspace })
  await execFile('git', ['config', 'user.name', 'Benchmark Controller'], { cwd: workspace })
  await writeFile(join(workspace, '.git', 'info', 'exclude'), 'node_modules\n.benchmarks\n', 'utf8')
  await execFile('git', ['add', '--all'], { cwd: workspace })
  await execFile('git', ['commit', '--quiet', '-m', 'benchmark baseline'], { cwd: workspace })
  if (dependencyMode === 'symlink') {
    const sourceNodeModules = join(repoRoot, 'node_modules')
    try {
      await accessDirectory(sourceNodeModules)
      await symlink(sourceNodeModules, join(workspace, 'node_modules'), 'junction')
    } catch {
      // The agent can still run if the task does not need the repository dependencies.
    }
  } else if (dependencyMode === 'install') {
    await runCommand('npm', ['ci', '--ignore-scripts'], workspace, { timeoutMs: 10 * 60_000 })
  }
}

async function changedFilesIn(workspace: string): Promise<string[]> {
  try {
    const result = await execFile('git', ['status', '--short'], { cwd: workspace, maxBuffer: 4 * 1024 * 1024 })
    return result.stdout.split(/\r?\n/).map((line) => line.slice(3).trim()).filter(Boolean)
  } catch {
    return []
  }
}

function selectManifest(manifest: BenchmarkManifest, options: RunnerOptions): BenchmarkManifest {
  const tasks = options.tasks ? manifest.taskSet.tasks.filter((task) => options.tasks?.has(task.id)) : manifest.taskSet.tasks
  if (tasks.length === 0) throw new Error('task selection produced no tasks')
  const arms = options.arms
    ? manifest.arms.map((arm) => ({ ...arm, enabled: options.arms!.has(arm.id) }))
    : manifest.arms
  if (arms.filter((arm) => arm.enabled).length < 2) throw new Error('arm selection must leave at least two enabled arms')
  return {
    ...manifest,
    repetitions: options.repeats ?? manifest.repetitions,
    taskSet: { ...manifest.taskSet, tasks },
    arms,
  }
}

function orderedArms(arms: BenchmarkArm[], ordering: BenchmarkManifest['ordering'], repeat: number, taskIndex: number): BenchmarkArm[] {
  if (ordering === 'fixed' || arms.length < 2 || (repeat + taskIndex) % 2 === 0) return [...arms]
  return [...arms.slice(1), arms[0]!]
}

function schedule(manifest: FrozenManifest): Array<{ repeat: number; taskId: string; arms: HarnessID[] }> {
  const rows: Array<{ repeat: number; taskId: string; arms: HarnessID[] }> = []
  const arms = manifest.arms.filter((arm) => arm.enabled)
  for (let repeat = 1; repeat <= manifest.repetitions; repeat += 1) {
    manifest.taskSet.tasks.forEach((task, taskIndex) => rows.push({
      repeat,
      taskId: task.id,
      arms: orderedArms(arms, manifest.ordering, repeat, taskIndex).map((arm) => arm.id),
    }))
  }
  return rows
}

async function loadManifest(path: string): Promise<BenchmarkManifest> {
  const value = JSON.parse(await readFile(path, 'utf8')) as BenchmarkManifest
  return value
}

function environmentSnapshot(): Record<string, string> {
  const names = [
    'CUPPET_AB_MODEL', 'CUPPET_AB_VARIANT', 'CUPPET_OPENCODE_BIN', 'CUPPET_TST_BIN',
    'CUPPET_BENCHMARK_CODEX_BIN', 'CUPPET_BENCHMARK_CLAUDE_BIN', 'LANG', 'LC_ALL', 'TZ',
  ]
  return {
    NODE_VERSION: process.version,
    PLATFORM: process.platform,
    ARCH: process.arch,
    ...Object.fromEntries(names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]!]])),
  }
}

function expandEnvironment(environment: Record<string, string> | undefined, values: PlaceholderValues): Record<string, string> {
  if (!environment) return {}
  return Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, expandCommandArgs([value], values)[0]!]))
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  options: { timeoutMs: number; env?: Record<string, string>; stdin?: string } = { timeoutMs: 120_000 },
): Promise<ProcessExecution> {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
  if (options.stdin !== undefined) child.stdin.end(options.stdin)
  else child.stdin.end()
  let timedOut = false
  const started = performance.now()
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }, 1_500).unref()
  }, options.timeoutMs)
  const exitCode = await new Promise<number | string>((resolveExit) => {
    let settled = false
    const settle = (value: number | string) => {
      if (settled) return
      settled = true
      resolveExit(value)
    }
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

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFile('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 })
  return result.stdout.trim()
}

async function accessDirectory(path: string): Promise<void> {
  await execFile('test', ['-d', path])
}

function renderMarkdown(report: BenchmarkReport): string {
  const lines = [
    `# ${report.manifest.name}`,
    '',
    `- Status: **${report.status}**`,
    `- Benchmark version: \`${report.manifest.benchmarkVersion}\``,
    `- Repository SHA: \`${report.manifest.repository.resolvedSha}\``,
    `- Task set: \`${report.manifest.taskSet.id}@${report.manifest.taskSet.version}\` (${report.manifest.taskSet.tasks.length} tasks)`,
    `- Manifest SHA-256: \`${report.manifest.manifestSha256}\``,
    `- Repetitions: ${report.manifest.repetitions}`,
    `- Controller: ${report.manifest.controller.provider}/${report.manifest.controller.model} (${report.manifest.controller.version})`,
    '',
    '## Headline metrics',
    '',
    '| Metric | ' + report.summaries.map((summary) => summary.arm).join(' | ') + ' |',
    '|---|' + report.summaries.map(() => '---:').join('|') + '|',
    ...metricRows(report),
    '',
    '## Uncertainty',
    '',
    ...report.summaries.map((summary) => `- **${summary.arm}**: model tokens/task ${formatDistribution(summary.modelTokens)}; successful-task tokens ${formatDistribution(summary.successfulModelTokens)}; wall time ${formatDistribution(summary.wallClockMs)}.`),
    '',
    '## Parity and controller notes',
    '',
    ...report.manifest.arms.filter((arm) => arm.enabled).map((arm) => `- **${arm.id}**: ${arm.harnessVersion}; config SHA-256 \`${arm.configSha256}\`.`),
    ...report.notes.map((note) => `- ${note}`),
    '',
    '## Per-task results',
    '',
    ...report.taskResults.map((result) => `- Repeat ${result.repeat}, **${result.arm}**, \`${result.taskId}\`: ${result.success ? 'success' : 'failed'}; acceptance ${(result.acceptanceScore * 100).toFixed(1)}%; model tokens ${result.run.usage.totalModelTokens}; cached input ${result.run.usage.cachedInputTokens}; uncached input ${result.run.usage.uncachedInputTokens}; tools ${result.run.toolCalls}${result.error ? `; ${result.error}` : ''}.`),
    '',
  ]
  return lines.join('\n')
}

function metricRows(report: BenchmarkReport): string[] {
  const rows: Array<[string, (summary: ReturnType<typeof summarizeArmResults>) => string]> = [
    ['Successful tasks', (summary) => `${summary.tasksSuccessful}/${summary.tasksAttempted}`],
    ['Success rate (95% CI)', (summary) => `${percent(summary.successRate)} (${summary.successRateConfidenceInterval95 ? `${percent(summary.successRateConfidenceInterval95.lower)}–${percent(summary.successRateConfidenceInterval95.upper)}` : 'n/a'})`],
    ['First-attempt success', (summary) => percent(summary.firstAttemptSuccessRate)],
    ['Acceptance checks', (summary) => `${summary.acceptanceChecksPassed}/${summary.acceptanceChecksTotal}`],
    ['Model tokens/task (median)', (summary) => number(summary.modelTokens.median)],
    ['Model tokens/successful task', (summary) => number(summary.modelTokensPerSuccessfulTask)],
    ['Uncached input/task (median)', (summary) => number(summary.uncachedInputTokens.median)],
    ['Cached input/task (median)', (summary) => number(summary.cachedInputTokens.median)],
    ['Output tokens/task (median)', (summary) => number(summary.outputTokens.median)],
    ['Tool calls/task (median)', (summary) => number(summary.toolCalls.median)],
    ['Retries', (summary) => String(summary.retries)],
    ['Compactions', (summary) => String(summary.compactions)],
    ['Regressions', (summary) => String(summary.regressions)],
    ['Effective cost/task (median)', (summary) => summary.effectiveCost.median === null ? 'unavailable' : `$${summary.effectiveCost.median.toFixed(6)}`],
  ]
  return rows.map(([label, value]) => `| ${label} | ${report.summaries.map(value).join(' | ')} |`)
}

function formatDistribution(distribution: { median: number | null; confidenceInterval95: { lower: number; upper: number } | null }): string {
  if (distribution.median === null) return 'unavailable'
  if (!distribution.confidenceInterval95) return `${Math.round(distribution.median)} (n=1; CI unavailable)`
  return `${Math.round(distribution.median)} (95% mean CI ${Math.round(distribution.confidenceInterval95.lower)}–${Math.round(distribution.confidenceInterval95.upper)})`
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function number(value: number | null): string {
  return value === null ? 'n/a' : Math.round(value).toLocaleString('en-US')
}

function truncate(value: string): string {
  return value.length > 12_000 ? `${value.slice(0, 12_000)}\n…<truncated>` : value
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'benchmark'
}

function workspaceOrThrow(workspace: string): string {
  if (!workspace) throw new Error('benchmark workspace is empty')
  return workspace
}

function parseArgs(argv: string[]): RunnerOptions {
  const options: RunnerOptions = {
    manifestPath: 'benchmarks/manifests/issue-4.json',
    outputDirectory: 'benchmarks/results',
    dryRun: false,
    keepWorkspaces: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--keep-workspaces') {
      options.keepWorkspaces = true
    } else if (arg === '--manifest' || arg === '--output' || arg === '--repeats' || arg === '--arms' || arg === '--tasks') {
      const value = argv[++index]
      if (!value) throw new Error(`${arg} requires a value`)
      if (arg === '--manifest') options.manifestPath = value
      if (arg === '--output') options.outputDirectory = value
      if (arg === '--repeats') options.repeats = positiveInteger(value, '--repeats')
      if (arg === '--arms') options.arms = new Set(value.split(',').map(parseHarness))
      if (arg === '--tasks') options.tasks = new Set(value.split(',').map((task) => task.trim()).filter(Boolean))
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function parseHarness(value: string): HarnessID {
  if (value === 'cuppet' || value === 'opencode' || value === 'codex' || value === 'claude-code') return value
  throw new Error(`unsupported harness: ${value}`)
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
  return parsed
}
