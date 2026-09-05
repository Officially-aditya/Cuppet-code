import assert from 'node:assert/strict'
import test from 'node:test'
import {
  freezeManifest,
  sha256Text,
  summarizeArmResults,
  summarizeDistribution,
  validateManifest,
  type BenchmarkManifest,
  type TaskRunResult,
} from './benchmark-contract.js'

test('benchmark manifests freeze repository and byte-identical task prompt hashes', () => {
  const manifest = makeManifest()
  validateManifest(manifest)
  const frozen = freezeManifest(manifest, 'a'.repeat(40), { NODE_VERSION: 'v22' })
  assert.equal(frozen.repository.resolvedSha, 'a'.repeat(40))
  assert.equal(frozen.taskSet.promptSha256ByTask.alpha, sha256Text('same prompt'))
  assert.equal(frozen.taskSet.sha256.length, 64)
  assert.equal(frozen.manifestSha256.length, 64)
})

test('distribution summaries expose uncertainty only when repeated observations exist', () => {
  const singleton = summarizeDistribution([10])
  assert.equal(singleton.median, 10)
  assert.equal(singleton.confidenceInterval95, null)
  const repeated = summarizeDistribution([10, 20, 30])
  assert.equal(repeated.mean, 20)
  assert.equal(repeated.median, 20)
  assert.ok(repeated.standardDeviation! > 0)
  assert.ok(repeated.confidenceInterval95!.lower < 20)
  assert.ok(repeated.confidenceInterval95!.upper > 20)
})

test('arm summaries retain failed-task cost and report successful-task efficiency separately', () => {
  const results = [
    taskResult(true, 100, 0.10),
    taskResult(false, 50, 0.05),
  ]
  const summary = summarizeArmResults('cuppet', results)
  assert.equal(summary.tasksAttempted, 2)
  assert.equal(summary.tasksSuccessful, 1)
  assert.ok(summary.successRateConfidenceInterval95!.lower <= 0.5)
  assert.ok(summary.successRateConfidenceInterval95!.upper >= 0.5)
  assert.equal(summary.modelTokensPerSuccessfulTask, 150)
  assert.ok(Math.abs(summary.effectiveCost.median! - 0.075) < 1e-12)
  assert.equal(summary.successfulEffectiveCost.median, 0.1)
})

function makeManifest(): BenchmarkManifest {
  return {
    schema: 1,
    benchmarkVersion: 'test',
    name: 'test',
    repository: { path: '.', startingSha: 'b'.repeat(40) },
    taskSet: {
      id: 'test',
      version: '1',
      tasks: [
        {
          id: 'alpha',
          title: 'Alpha',
          family: 'isolated',
          sessionMode: 'isolated',
          prompt: 'same prompt',
          verification: [{ id: 'verify', command: 'true', args: [], timeoutMs: 1000 }],
        },
      ],
    },
    model: { provider: 'openai', model: 'gpt-5.6-luna', reasoningEffort: 'low' },
    controller: {
      provider: 'local',
      model: 'node',
      version: 'test',
      networkPolicy: 'none',
      role: 'controller',
    },
    workspace: { dependencyMode: 'none', timeoutMs: 1000 },
    repetitions: 2,
    ordering: 'alternate',
    arms: [
      arm('cuppet'),
      arm('opencode'),
    ],
  }
}

function arm(id: 'cuppet' | 'opencode'): BenchmarkManifest['arms'][number] {
  return {
    id,
    enabled: true,
    harnessVersion: 'test-harness',
    command: { command: 'node', args: ['worker', '{workspace}'] },
    telemetry: 'result-file',
    model: {
      provider: 'openai',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      parity: 'exact',
      notes: 'test',
    },
  }
}

function taskResult(success: boolean, tokens: number, cost: number): TaskRunResult {
  return {
    arm: 'cuppet',
    taskId: success ? 'success' : 'failure',
    repeat: 1,
    sessionMode: 'isolated',
    workspace: '<removed>',
    promptSha256: 'a'.repeat(64),
    run: {
      schema: 1,
      arm: 'cuppet',
      taskId: success ? 'success' : 'failure',
      harnessVersion: 'test-harness',
      sessionId: 'session',
      startedAt: '2026-09-05T00:00:00.000Z',
      completedAt: '2026-09-05T00:00:01.000Z',
      durationMs: 1000,
      success,
      attempts: 1,
      firstAttemptSuccess: success,
      retries: 0,
      usage: {
        inputTokens: tokens,
        cachedInputTokens: 0,
        uncachedInputTokens: tokens,
        outputTokens: 0,
        reasoningTokens: 0,
        totalModelTokens: tokens,
        effectiveCost: cost,
      },
      toolCalls: 1,
      compactions: 0,
      regressions: 0,
      permissionRequests: 0,
      rejectedPermissions: 0,
      telemetry: { source: 'native', complete: true, eventCount: 1 },
      model: { provider: 'openai', model: 'gpt-5.6-luna', reasoningEffort: 'low' },
      parity: { status: 'exact', notes: 'test' },
      finalMessage: '',
    },
    verification: [{ id: 'verify', command: 'true', args: [], passed: success, exitCode: 0, stdout: '', stderr: '', durationMs: 1 }],
    acceptanceScore: success ? 1 : 0,
    success,
    changedFiles: [],
    gitDiffStat: '',
    completedAt: '2026-09-05T00:00:01.000Z',
  }
}
