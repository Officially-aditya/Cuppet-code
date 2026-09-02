import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  runPe3Benchmark,
  runPe3BenchmarkArm,
  semanticCalibrationRows,
} from '../src/benchmark/pe3-routing.js'
import { SemanticTaskRouter, type TaskEmbeddingProvider } from '../src/pe3/semantic-router.js'
import { TaskSessionRouter } from '../src/pe3/session-router.js'

const sequence = [
  { taskID: 'A', prompt: 'fix refresh token expiry in src/auth/token.ts' },
  { taskID: 'A', prompt: 'also update refresh token tests in src/auth/token.test.ts' },
  { taskID: 'B', prompt: 'separately, new task: add analytics csv export in src/analytics/export.ts' },
  { taskID: 'B', prompt: 'also add analytics export tests' },
  { taskID: 'C', prompt: 'separately, new task: implement billing invoice retry in src/billing/retry.ts' },
  { taskID: 'A', prompt: 'go back to the refresh token issue in src/auth/token.ts' },
]

const naturalSequence = [
  { taskID: 'A', prompt: 'fix refresh token expiration' },
  { taskID: 'A', prompt: 'repair the oauth credential renewal lifecycle regression' },
  { taskID: 'B', prompt: 'add pagination to the csv export pipeline' },
  { taskID: 'B', prompt: 'make the data download stream pages reliable' },
  { taskID: 'C', prompt: 'create an organization schema migration lifecycle' },
  { taskID: 'A', prompt: 'the oauth credential renewal lifecycle regressed again' },
]

test('A → A → B → B → C → A benchmark compares all required PE3 arms', async () => {
  const results = await runPe3Benchmark(sequence)
  assert.deepEqual(results.map((result) => result.arm), [
    'current',
    'pe3_no_routing',
    'oracle',
    'detected',
  ])

  const current = results.find((result) => result.arm === 'current')!
  const oracle = results.find((result) => result.arm === 'oracle')!
  const detected = results.find((result) => result.arm === 'detected')!

  assert.equal(current.metrics.missedTaskSwitches, 3)
  assert.equal(oracle.metrics.missedTaskSwitches, 0)
  assert.equal(oracle.metrics.unnecessaryAgentSwitches, 0)
  assert.equal(detected.metrics.missedTaskSwitches, 0)
  assert.equal(detected.metrics.unnecessaryAgentSwitches, 0)
  assert.deepEqual(detected.turns.map((turn) => turn.action), [
    'create',
    'continue',
    'create',
    'continue',
    'create',
    'reactivate',
  ])
  assert.equal(detected.turns[5]?.sessionID, detected.turns[0]?.sessionID)
})

test('natural-language benchmark covers vocabulary gaps and task switches without cue phrases', async () => {
  const detectedRouter = new TaskSessionRouter(undefined, {
    semantic: new SemanticTaskRouter(benchmarkEmbeddingProvider()),
  })
  const result = await runPe3BenchmarkArm('detected', naturalSequence, { detectedRouter })

  assert.deepEqual(result.turns.map((turn) => turn.action), [
    'create',
    'continue',
    'create',
    'continue',
    'create',
    'reactivate',
  ])
  assert.equal(result.metrics.missedTaskSwitches, 0)
  assert.equal(result.metrics.unnecessaryAgentSwitches, 0)
  assert.ok(result.metrics.semanticEscalations >= 4)

  const calibration = semanticCalibrationRows(result)
  assert.ok(calibration.length >= 4)
  assert.ok(calibration.every((row) => row.modelID === 'benchmark-minilm'))
  assert.ok(calibration.some((row) => row.expectedSwitch && row.actualSwitch))
  assert.ok(calibration.some((row) => !row.expectedSwitch && !row.actualSwitch))
})

test('benchmark aggregates correctness, retry, cache, cost, stale-context, and latency telemetry', async () => {
  const result = await runPe3BenchmarkArm('detected', [
    {
      taskID: 'A',
      prompt: 'fix auth in src/auth.ts',
      outcome: {
        success: true,
        firstPassSuccess: true,
        cachedInput: 8_000,
        uncachedInput: 2_000,
        outputTokens: 500,
        effectiveCost: 0.02,
        latencyMs: 1_200,
      },
    },
    {
      taskID: 'B',
      prompt: 'separately, new task: fix billing in src/billing.ts',
      outcome: {
        success: true,
        firstPassSuccess: false,
        retries: 1,
        staleContextIncident: true,
        cachedInput: 1_000,
        uncachedInput: 4_000,
        outputTokens: 600,
        effectiveCost: 0.03,
        latencyMs: 1_800,
      },
    },
  ])

  assert.equal(result.metrics.taskSuccessRate, 1)
  assert.equal(result.metrics.firstPassSuccessRate, 0.5)
  assert.equal(result.metrics.retries, 1)
  assert.equal(result.metrics.staleContextIncidents, 1)
  assert.equal(result.metrics.cachedInput, 9_000)
  assert.equal(result.metrics.uncachedInput, 6_000)
  assert.equal(result.metrics.outputTokens, 1_100)
  assert.equal(result.metrics.providerAdjustedEffectiveCost, 0.05)
  assert.equal(result.metrics.latencyMs, 3_000)
  assert.equal(result.metrics.cacheReuseRatio, 0.6)
})

function benchmarkEmbeddingProvider(): TaskEmbeddingProvider {
  return {
    modelID: 'benchmark-minilm',
    embed: async (text) => {
      const value = text.toLowerCase()
      if (value.includes('refresh token') || value.includes('credential renewal') || value.includes('oauth')) {
        return new Float32Array([1, 0, 0, 0])
      }
      if (value.includes('csv') || value.includes('download stream') || value.includes('export pipeline')) {
        return new Float32Array([0, 1, 0, 0])
      }
      if (value.includes('organization') || value.includes('schema migration')) {
        return new Float32Array([0, 0, 1, 0])
      }
      return new Float32Array([0, 0, 0, 1])
    },
  }
}
