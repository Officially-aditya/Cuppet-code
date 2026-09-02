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

type OutcomeTrace = Partial<Record<Pe3BenchmarkArm, Pe3TurnOutcome[]>>

async function main(): Promise<void> {
  const trace = await loadOutcomeTrace(process.env.CUPPET_PE3_BENCHMARK_TRACE)
  const arms = await runPe3Benchmark(DEFAULT_SEQUENCE)
  const results = await Promise.all(arms.map(async (result) => {
    const outcomes = trace?.[result.arm]
    if (!outcomes) return result
    const turns = DEFAULT_SEQUENCE.map((turn, index) => ({
      ...turn,
      ...(outcomes[index] ? { outcome: outcomes[index] } : {}),
    }))
    return (await runPe3Benchmark(turns)).find((candidate) => candidate.arm === result.arm)!
  }))

  process.stdout.write(`${JSON.stringify({
    schema: 1,
    experiment: 'pe3-task-routing',
    sequence: DEFAULT_SEQUENCE.map(({ taskID, prompt }) => ({ taskID, prompt })),
    metricsSource: trace
      ? 'routing decisions plus supplied live/provider outcome trace'
      : 'routing decisions only; provider outcome metrics are zero until CUPPET_PE3_BENCHMARK_TRACE is supplied',
    arms: results.map((result) => ({ arm: result.arm, metrics: result.metrics, turns: result.turns })),
  }, null, 2)}\n`)
}

async function loadOutcomeTrace(path: string | undefined): Promise<OutcomeTrace | undefined> {
  if (!path) return undefined
  const parsed = JSON.parse(await readFile(resolve(path), 'utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CUPPET_PE3_BENCHMARK_TRACE must contain a JSON object keyed by benchmark arm')
  }
  return parsed as OutcomeTrace
}

await main()
