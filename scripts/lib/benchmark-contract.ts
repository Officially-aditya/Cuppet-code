import { createHash } from 'node:crypto'

export const BENCHMARK_SCHEMA = 1 as const

export const HARNESS_IDS = ['cuppet', 'opencode', 'codex', 'claude-code'] as const
export type HarnessID = typeof HARNESS_IDS[number]

export const TASK_FAMILIES = [
  'isolated',
  'persistent',
  'discontinuity',
  'long-tool-use',
  'cross-file',
] as const
export type TaskFamily = typeof TASK_FAMILIES[number]

export type ModelSpec = {
  provider: string
  model: string
  reasoningEffort: string
}

export type CommandSpec = {
  command: string
  args: string[]
  env?: Record<string, string>
  stdin?: boolean
}

export type VerificationSpec = {
  id: string
  command: string
  args: string[]
  timeoutMs: number
  expectedExitCode?: number
}

export type BenchmarkTask = {
  id: string
  title: string
  family: TaskFamily
  prompt: string
  verification: VerificationSpec[]
  sessionMode: 'isolated' | 'persistent'
  tags?: string[]
}

export type BenchmarkArm = {
  id: HarnessID
  enabled: boolean
  harnessVersion: string
  command: CommandSpec
  model: ModelSpec & {
    parity: 'exact' | 'product-comparison' | 'unavailable'
    notes: string
  }
  telemetry: 'result-file'
}

export type BenchmarkManifest = {
  schema: typeof BENCHMARK_SCHEMA
  benchmarkVersion: string
  name: string
  repository: {
    path: string
    startingSha: string
  }
  taskSet: {
    id: string
    version: string
    tasks: BenchmarkTask[]
  }
  model: ModelSpec
  controller: {
    provider: string
    model: string
    version: string
    networkPolicy: string
    role: string
  }
  workspace: {
    dependencyMode: 'symlink' | 'install' | 'none'
    timeoutMs: number
  }
  repetitions: number
  ordering: 'alternate' | 'fixed'
  arms: BenchmarkArm[]
}

export type UsageTotals = {
  inputTokens: number
  cachedInputTokens: number
  uncachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  totalModelTokens: number
  effectiveCost: number | null
}

export type HarnessRunResult = {
  schema: typeof BENCHMARK_SCHEMA
  arm: HarnessID
  taskId: string
  harnessVersion: string
  sessionId: string
  startedAt: string
  completedAt: string
  durationMs: number
  success: boolean
  attempts: number
  firstAttemptSuccess: boolean
  retries: number
  usage: UsageTotals
  toolCalls: number
  compactions: number
  regressions: number
  permissionRequests: number
  rejectedPermissions: number
  telemetry: {
    source: 'native' | 'codex-jsonl' | 'claude-stream-json' | 'unavailable'
    complete: boolean
    eventCount: number
  }
  model: ModelSpec
  parity: {
    status: BenchmarkArm['model']['parity']
    notes: string
  }
  finalMessage: string
  error?: string
}

export type VerificationResult = {
  id: string
  command: string
  args: string[]
  passed: boolean
  exitCode: number | string
  stdout: string
  stderr: string
  durationMs: number
}

export type TaskRunResult = {
  arm: HarnessID
  taskId: string
  repeat: number
  sessionMode: BenchmarkTask['sessionMode']
  workspace: string
  promptSha256: string
  run: HarnessRunResult
  verification: VerificationResult[]
  acceptanceScore: number
  success: boolean
  changedFiles: string[]
  gitDiffStat: string
  completedAt: string
  error?: string
}

export type Distribution = {
  count: number
  mean: number | null
  median: number | null
  standardDeviation: number | null
  confidenceInterval95: { lower: number; upper: number } | null
}

export type ArmSummary = {
  arm: HarnessID
  tasksAttempted: number
  tasksSuccessful: number
  successRate: number
  successRateConfidenceInterval95: { lower: number; upper: number } | null
  firstAttemptSuccesses: number
  firstAttemptSuccessRate: number
  acceptanceChecksPassed: number
  acceptanceChecksTotal: number
  acceptanceRate: number
  modelTokens: Distribution
  successfulModelTokens: Distribution
  uncachedInputTokens: Distribution
  cachedInputTokens: Distribution
  outputTokens: Distribution
  toolCalls: Distribution
  retries: number
  compactions: number
  regressions: number
  wallClockMs: Distribution
  effectiveCost: Distribution
  successfulEffectiveCost: Distribution
  modelTokensPerSuccessfulTask: number | null
  parity: Array<{ status: BenchmarkArm['model']['parity']; notes: string }>
}

export type FrozenManifest = Omit<BenchmarkManifest, 'repository' | 'taskSet' | 'arms'> & {
  resolvedAt: string
  repository: BenchmarkManifest['repository'] & {
    resolvedSha: string
  }
  taskSet: BenchmarkManifest['taskSet'] & {
    sha256: string
    promptSha256ByTask: Record<string, string>
  }
  arms: Array<BenchmarkArm & { configSha256: string }>
  environment: Record<string, string>
  manifestSha256: string
}

export type BenchmarkReport = {
  schema: typeof BENCHMARK_SCHEMA
  status: 'completed' | 'failed'
  createdAt: string
  completedAt: string
  manifest: FrozenManifest
  runRoot: string
  taskResults: TaskRunResult[]
  summaries: ArmSummary[]
  notes: string[]
}

export type PlaceholderValues = {
  arm: HarnessID
  controllerRoot: string
  workspace: string
  promptFile: string
  resultFile: string
  sequenceFile: string
  runtimeRoot: string
  taskId: string
  repeat: string
  model: string
  provider: string
  reasoningEffort: string
  timeoutMs: string
  sessionMode: string
}

export function validateManifest(manifest: BenchmarkManifest): void {
  if (manifest.schema !== BENCHMARK_SCHEMA) throw new Error(`unsupported benchmark schema: ${String(manifest.schema)}`)
  if (!manifest.benchmarkVersion.trim()) throw new Error('benchmarkVersion is required')
  if (!manifest.name.trim()) throw new Error('name is required')
  if (!/^[a-f0-9]{40}$/.test(manifest.repository.startingSha)) {
    throw new Error('repository.startingSha must be a full 40-character Git SHA')
  }
  if (manifest.repetitions < 1 || !Number.isInteger(manifest.repetitions)) throw new Error('repetitions must be a positive integer')
  if (manifest.workspace.timeoutMs < 1 || !Number.isFinite(manifest.workspace.timeoutMs)) throw new Error('workspace.timeoutMs must be positive')
  if (manifest.ordering !== 'alternate' && manifest.ordering !== 'fixed') throw new Error(`unsupported ordering: ${manifest.ordering}`)
  validateModel(manifest.model, 'model')
  if (!manifest.controller.provider || !manifest.controller.model || !manifest.controller.version) {
    throw new Error('controller provider, model, and version are required')
  }
  if (manifest.taskSet.tasks.length === 0) throw new Error('taskSet.tasks must not be empty')
  const taskIDs = new Set<string>()
  const promptHashes = new Set<string>()
  for (const task of manifest.taskSet.tasks) {
    if (taskIDs.has(task.id)) throw new Error(`duplicate task id: ${task.id}`)
    taskIDs.add(task.id)
    if (!task.title.trim() || !task.prompt.trim()) throw new Error(`task ${task.id} needs a title and prompt`)
    if (!TASK_FAMILIES.includes(task.family)) throw new Error(`task ${task.id} has an unsupported family`)
    if (task.sessionMode === 'persistent' && task.family === 'isolated') {
      throw new Error(`isolated task ${task.id} cannot use persistent sessionMode`)
    }
    if (task.verification.length === 0) throw new Error(`task ${task.id} needs at least one deterministic verifier`)
    for (const verification of task.verification) validateVerification(verification, task.id)
    const promptHash = sha256Text(task.prompt)
    if (promptHashes.has(promptHash)) throw new Error(`duplicate task prompt: ${task.id}`)
    promptHashes.add(promptHash)
  }
  const enabledArms = manifest.arms.filter((arm) => arm.enabled)
  if (enabledArms.length < 2) throw new Error('at least two enabled arms are required')
  const armIDs = new Set<string>()
  for (const arm of manifest.arms) {
    if (armIDs.has(arm.id)) throw new Error(`duplicate arm id: ${arm.id}`)
    armIDs.add(arm.id)
    if (!arm.harnessVersion.trim()) throw new Error(`arm ${arm.id}.harnessVersion is required`)
    validateModel(arm.model, `arm ${arm.id}.model`)
    if (arm.telemetry !== 'result-file') throw new Error(`arm ${arm.id} must use result-file telemetry`)
    if (!arm.command.command.trim()) throw new Error(`arm ${arm.id} command is required`)
    if (!Array.isArray(arm.command.args)) throw new Error(`arm ${arm.id} args must be an array`)
  }
}

export function freezeManifest(manifest: BenchmarkManifest, resolvedSha: string, environment: Record<string, string>): FrozenManifest {
  validateManifest(manifest)
  if (!/^[a-f0-9]{40}$/.test(resolvedSha)) throw new Error('resolved repository SHA must be a full Git SHA')
  const promptSha256ByTask = Object.fromEntries(manifest.taskSet.tasks.map((task) => [task.id, sha256Text(task.prompt)]))
  const taskSet = {
    ...manifest.taskSet,
    sha256: sha256Text(stableStringify(manifest.taskSet)),
    promptSha256ByTask,
  }
  const frozenWithoutHash = {
    ...manifest,
    resolvedAt: new Date().toISOString(),
    repository: { ...manifest.repository, resolvedSha },
    taskSet,
    arms: manifest.arms.map((arm) => ({ ...arm, configSha256: sha256Text(stableStringify(arm)) })),
    environment,
  }
  return {
    ...frozenWithoutHash,
    manifestSha256: sha256Text(stableStringify(frozenWithoutHash)),
  }
}

export function expandCommandArgs(args: readonly string[], values: PlaceholderValues): string[] {
  return args.map((arg) => arg.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (whole, key: string) => {
    if (!(key in values)) throw new Error(`unknown benchmark command placeholder: ${whole}`)
    return values[key as keyof PlaceholderValues]
  }))
}

export function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

export function summarizeDistribution(values: readonly number[]): Distribution {
  const finite = values.filter((value) => Number.isFinite(value))
  if (finite.length === 0) {
    return { count: 0, mean: null, median: null, standardDeviation: null, confidenceInterval95: null }
  }
  const ordered = [...finite].sort((left, right) => left - right)
  const mean = ordered.reduce((total, value) => total + value, 0) / ordered.length
  const median = ordered.length % 2 === 1
    ? ordered[Math.floor(ordered.length / 2)]!
    : (ordered[ordered.length / 2 - 1]! + ordered[ordered.length / 2]!) / 2
  const variance = ordered.length > 1
    ? ordered.reduce((total, value) => total + ((value - mean) ** 2), 0) / (ordered.length - 1)
    : 0
  const standardDeviation = Math.sqrt(variance)
  const margin = ordered.length > 1 ? 1.96 * standardDeviation / Math.sqrt(ordered.length) : null
  return {
    count: ordered.length,
    mean,
    median,
    standardDeviation,
    confidenceInterval95: margin === null
      ? null
      : { lower: Math.max(0, mean - margin), upper: mean + margin },
  }
}

export function summarizeArmResults(arm: HarnessID, results: readonly TaskRunResult[]): ArmSummary {
  const armResults = results.filter((result) => result.arm === arm)
  const successful = armResults.filter((result) => result.success)
  const checks = armResults.flatMap((result) => result.verification)
  const passedChecks = checks.filter((check) => check.passed).length
  const costs = armResults.map((result) => result.run.usage.effectiveCost).filter(isNumber)
  const successfulCosts = successful.map((result) => result.run.usage.effectiveCost).filter(isNumber)
  return {
    arm,
    tasksAttempted: armResults.length,
    tasksSuccessful: successful.length,
    successRate: rate(successful.length, armResults.length),
    successRateConfidenceInterval95: wilsonInterval(successful.length, armResults.length),
    firstAttemptSuccesses: armResults.filter((result) => result.success && result.run.firstAttemptSuccess).length,
    firstAttemptSuccessRate: rate(armResults.filter((result) => result.success && result.run.firstAttemptSuccess).length, armResults.length),
    acceptanceChecksPassed: passedChecks,
    acceptanceChecksTotal: checks.length,
    acceptanceRate: rate(passedChecks, checks.length),
    modelTokens: summarizeDistribution(armResults.map((result) => result.run.usage.totalModelTokens)),
    successfulModelTokens: summarizeDistribution(successful.map((result) => result.run.usage.totalModelTokens)),
    uncachedInputTokens: summarizeDistribution(armResults.map((result) => result.run.usage.uncachedInputTokens)),
    cachedInputTokens: summarizeDistribution(armResults.map((result) => result.run.usage.cachedInputTokens)),
    outputTokens: summarizeDistribution(armResults.map((result) => result.run.usage.outputTokens)),
    toolCalls: summarizeDistribution(armResults.map((result) => result.run.toolCalls)),
    retries: armResults.reduce((total, result) => total + result.run.retries, 0),
    compactions: armResults.reduce((total, result) => total + result.run.compactions, 0),
    regressions: armResults.reduce((total, result) => total + result.run.regressions, 0),
    wallClockMs: summarizeDistribution(armResults.map((result) => result.run.durationMs)),
    effectiveCost: summarizeDistribution(costs),
    successfulEffectiveCost: summarizeDistribution(successfulCosts),
    modelTokensPerSuccessfulTask: successful.length > 0
      ? armResults.reduce((total, result) => total + result.run.usage.totalModelTokens, 0) / successful.length
      : null,
    parity: uniqueParity(armResults),
  }
}

function validateModel(model: ModelSpec, label: string): void {
  if (!model.provider.trim() || !model.model.trim() || !model.reasoningEffort.trim()) {
    throw new Error(`${label} requires provider, model, and reasoningEffort`)
  }
}

function validateVerification(verification: VerificationSpec, taskID: string): void {
  if (!verification.id.trim() || !verification.command.trim()) throw new Error(`task ${taskID} has an invalid verification command`)
  if (!Array.isArray(verification.args)) throw new Error(`task ${taskID} verification args must be an array`)
  if (verification.timeoutMs < 1 || !Number.isFinite(verification.timeoutMs)) throw new Error(`task ${taskID} verification timeout must be positive`)
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, sortValue(nested)]))
}

function isNumber(value: number | null): value is number {
  return value !== null && Number.isFinite(value)
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0
}

function wilsonInterval(successes: number, observations: number): { lower: number; upper: number } | null {
  if (observations < 1) return null
  const z = 1.96
  const proportion = successes / observations
  const denominator = 1 + (z ** 2) / observations
  const center = (proportion + (z ** 2) / (2 * observations)) / denominator
  const spread = z * Math.sqrt((proportion * (1 - proportion) / observations) + (z ** 2) / (4 * observations ** 2)) / denominator
  return { lower: Math.max(0, center - spread), upper: Math.min(1, center + spread) }
}

function uniqueParity(results: readonly TaskRunResult[]): ArmSummary['parity'] {
  const seen = new Set<string>()
  const values: ArmSummary['parity'] = []
  for (const result of results) {
    const key = `${result.run.parity.status}\u0000${result.run.parity.notes}`
    if (seen.has(key)) continue
    seen.add(key)
    values.push({ ...result.run.parity })
  }
  return values
}
