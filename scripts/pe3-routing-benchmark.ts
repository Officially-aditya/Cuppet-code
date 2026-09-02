import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  runPe3Benchmark,
  type Pe3BenchmarkArm,
  type Pe3BenchmarkTurn,
  type Pe3TurnOutcome,
} from '../packages/cli/src/benchmark/pe3-routing.js'

const DEFAULT_SEQUENCE: Pe3BenchmarkTurn[] = [
  { taskID: 'A', prompt: 'fix refresh token expiry in src/auth/token.ts' },
  { taskID: 'A', prompt: 'also update refresh token tests in src/auth/token.test.ts' },
  { taskID: 'B', prompt: 'separately, new task: add analytics csv export in src/analytics/export.ts' },
  { taskID: 'B', prompt: 'also add analytics export tests' },
  { taskID: 'C', prompt: 'separately, new task: implement billing invoice retry in src/billing/retry.ts' },
  { taskID: 'A', prompt: 'go back to the refresh token issue in src/auth/token.ts' },
]

const BENCHMARK_ARMS = ['current', 'pe3_no_routing', 'oracle', 'detected'] as const satisfies readonly Pe3BenchmarkArm[]
const BOOLEAN_OUTCOME_FIELDS = ['success', 'firstPassSuccess', 'staleContextIncident'] as const
const NUMBER_OUTCOME_FIELDS = ['retries', 'cachedInput', 'uncachedInput', 'outputTokens', 'effectiveCost', 'latencyMs'] as const
const OUTCOME_FIELDS = new Set<string>([...BOOLEAN_OUTCOME_FIELDS, ...NUMBER_OUTCOME_FIELDS])

type OutcomeTrace = Record<Pe3BenchmarkArm, Pe3TurnOutcome[]>

async function main(): Promise<void> {
  const trace = await loadOutcomeTrace(process.env.CUPPET_PE3_BENCHMARK_TRACE)
  const arms = await runPe3Benchmark(DEFAULT_SEQUENCE)
  const results = await Promise.all(arms.map(async (result) => {
    if (!trace) return result
    const outcomes = trace[result.arm]
    const turns = DEFAULT_SEQUENCE.map((turn, index) => ({
      ...turn,
      outcome: outcomes[index]!,
    }))
    return (await runPe3Benchmark(turns)).find((candidate) => candidate.arm === result.arm)!
  }))

  process.stdout.write(`${JSON.stringify({
    schema: 1,
    experiment: 'pe3-task-routing',
    sequence: DEFAULT_SEQUENCE.map(({ taskID, prompt }) => ({ taskID, prompt })),
    metricsSource: trace
      ? 'routing decisions plus complete validated live/provider outcome trace'
      : 'routing decisions only; provider outcome metrics are zero until CUPPET_PE3_BENCHMARK_TRACE is supplied',
    arms: results.map((result) => ({ arm: result.arm, metrics: result.metrics, turns: result.turns })),
  }, null, 2)}\n`)
}

async function loadOutcomeTrace(path: string | undefined): Promise<OutcomeTrace | undefined> {
  if (!path) return undefined
  const parsed = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown
  if (!isRecord(parsed)) {
    throw new Error('CUPPET_PE3_BENCHMARK_TRACE must contain a JSON object keyed by benchmark arm')
  }

  const unknownArms = Object.keys(parsed).filter((arm) => !BENCHMARK_ARMS.includes(arm as Pe3BenchmarkArm))
  if (unknownArms.length > 0) {
    throw new Error(`CUPPET_PE3_BENCHMARK_TRACE contains unknown arms: ${unknownArms.join(', ')}`)
  }
  const missingArms = BENCHMARK_ARMS.filter((arm) => !(arm in parsed))
  if (missingArms.length > 0) {
    throw new Error(`CUPPET_PE3_BENCHMARK_TRACE is missing arms: ${missingArms.join(', ')}`)
  }

  const trace = {} as OutcomeTrace
  for (const arm of BENCHMARK_ARMS) {
    const value = parsed[arm]
    if (!Array.isArray(value) || value.length !== DEFAULT_SEQUENCE.length) {
      throw new Error(`${arm} trace must contain exactly ${DEFAULT_SEQUENCE.length} turn outcomes`)
    }
    trace[arm] = value.map((outcome, index) => parseOutcome(outcome, arm, index))
  }
  return trace
}

function parseOutcome(value: unknown, arm: Pe3BenchmarkArm, index: number): Pe3TurnOutcome {
  if (!isRecord(value)) throw new Error(`${arm}[${index}] must be an outcome object`)
  const unknownFields = Object.keys(value).filter((field) => !OUTCOME_FIELDS.has(field))
  if (unknownFields.length > 0) {
    throw new Error(`${arm}[${index}] contains unknown outcome fields: ${unknownFields.join(', ')}`)
  }

  for (const field of BOOLEAN_OUTCOME_FIELDS) {
    if (typeof value[field] !== 'boolean') throw new Error(`${arm}[${index}].${field} must be boolean`)
  }
  for (const field of NUMBER_OUTCOME_FIELDS) {
    const number = value[field]
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) {
      throw new Error(`${arm}[${index}].${field} must be a finite non-negative number`)
    }
  }
  if (!Number.isInteger(value.retries as number)) {
    throw new Error(`${arm}[${index}].retries must be an integer`)
  }

  return {
    success: value.success as boolean,
    firstPassSuccess: value.firstPassSuccess as boolean,
    retries: value.retries as number,
    staleContextIncident: value.staleContextIncident as boolean,
    cachedInput: value.cachedInput as number,
    uncachedInput: value.uncachedInput as number,
    outputTokens: value.outputTokens as number,
    effectiveCost: value.effectiveCost as number,
    latencyMs: value.latencyMs as number,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

await main()
