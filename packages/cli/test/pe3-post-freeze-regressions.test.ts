import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runPe3BenchmarkArm } from '../src/benchmark/pe3-routing.js'
import { nativeSemanticAttachmentText } from '../src/pe3/native-envelope.js'
import { SemanticTaskRouter, type TaskEmbeddingProvider } from '../src/pe3/semantic-router.js'
import { TaskSessionRouter, type TaskSessionAdapter } from '../src/pe3/session-router.js'

test('explicit new-task intent outranks a weak continuation cue', async () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  const harness = adapterHarness()

  const first = await router.prepare('fix refresh token expiration', harness.adapter)
  const second = await router.prepare('also, new task: add rate limiting', harness.adapter)

  assert.equal(first.action, 'create')
  assert.equal(second.action, 'create')
  assert.notEqual(second.sessionID, first.sessionID)
})

test('all explicit switch cues suppress the early continuation shortcut', async () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  const harness = adapterHarness()

  const first = await router.prepare('fix refresh token expiration', harness.adapter)
  const second = await router.prepare('also, now implement rate limiting middleware', harness.adapter)

  assert.equal(first.action, 'create')
  assert.equal(second.action, 'create')
  assert.notEqual(second.sessionID, first.sessionID)
})

test('terse attachment-dependent prompts can enter semantic escalation', async () => {
  const provider = new RecordingEmbeddingProvider()
  const router = new TaskSessionRouter(undefined, {
    semantic: new SemanticTaskRouter(provider),
  })
  const harness = adapterHarness()

  await router.prepare('fix refresh token expiration', harness.adapter)
  const context = nativeSemanticAttachmentText([
    { type: 'file', filename: 'dashboard.png', mime: 'image/png' },
  ])
  const result = await router.prepare('implement this', harness.adapter, { semanticContext: context })

  assert.equal(result.action, 'continue')
  assert.equal(provider.inputs[0], 'implement this\n[attachment dashboard.png image/png]')
  assert.equal(router.stats().semanticEscalations, 1)
})

test('explicit switch to a dormant concrete path reactivates the existing task identity', async () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  const harness = adapterHarness()

  const auth = await router.prepare('fix auth expiry in src/auth/token.ts', harness.adapter)
  const dashboard = await router.prepare('new task: build dashboard in src/dashboard/view.ts', harness.adapter)
  const returned = await router.prepare('switch to src/auth/token.ts', harness.adapter)

  assert.equal(dashboard.action, 'create')
  assert.equal(returned.action, 'reactivate')
  assert.equal(returned.sessionID, auth.sessionID)
  assert.equal(harness.created, 2)
})

test('benchmark identity metrics catch duplicate agents even when a task boundary was detected', async () => {
  const detectedRouter = new TaskSessionRouter(undefined, { semantic: false })
  const result = await runPe3BenchmarkArm('detected', [
    { taskID: 'A', prompt: 'fix refresh token expiration' },
    { taskID: 'B', prompt: 'new task: add csv export pagination' },
    { taskID: 'A', prompt: 'new task: repair refresh token behavior' },
  ], { detectedRouter })

  assert.equal(result.turns[2]?.actualSwitch, true)
  assert.equal(result.turns[2]?.missedSwitch, false)
  assert.equal(result.turns[2]?.taskIdentityCorrect, false)
  assert.equal(result.metrics.duplicateTaskAgents, 1)
  assert.equal(result.metrics.missedReactivations, 1)
  assert.equal(result.metrics.taskIdentityErrors, 1)
})

test('task success uses each task final outcome while turn success remains separately visible', async () => {
  const result = await runPe3BenchmarkArm('current', [
    { taskID: 'A', prompt: 'phase one', outcome: { success: false } },
    { taskID: 'A', prompt: 'phase two', outcome: { success: true } },
    { taskID: 'B', prompt: 'other task', outcome: { success: true } },
  ])

  assert.equal(result.metrics.turnSuccessRate, 2 / 3)
  assert.equal(result.metrics.taskSuccessRate, 1)
})

class RecordingEmbeddingProvider implements TaskEmbeddingProvider {
  readonly modelID = 'post-freeze-recording'
  readonly inputs: string[] = []

  async embed(text: string): Promise<Float32Array> {
    this.inputs.push(text)
    return Float32Array.from([1, 0])
  }
}

function adapterHarness(): { adapter: TaskSessionAdapter; readonly created: number } {
  let currentID: string | undefined
  let created = 0
  const adapter: TaskSessionAdapter = {
    current: () => currentID ? { id: currentID } : undefined,
    create: async () => {
      created += 1
      currentID = `s${created}`
      return { id: currentID }
    },
    resume: async (sessionID) => {
      currentID = sessionID
      return { id: sessionID }
    },
    evidence: () => ({}),
  }
  return {
    adapter,
    get created() { return created },
  }
}
