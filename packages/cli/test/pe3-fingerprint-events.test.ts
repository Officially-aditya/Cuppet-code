import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SemanticTaskRouter, type TaskEmbeddingProvider } from '../src/pe3/semantic-router.js'
import { TaskAgentRouter } from '../src/pe3/task-agents.js'

test('plain follow-up turns do not reinforce old artifact evidence or churn fingerprint revision', () => {
  let now = 0
  const router = new TaskAgentRouter({ now: () => ++now })
  router.register('s1', 'fix auth token behavior', { activePaths: ['src/auth/token.ts'] })

  const before = router.active!
  const beforePath = pathSignal(before, 'src/auth/token.ts')

  for (let index = 0; index < 10; index += 1) {
    const route = router.route('also')
    assert.equal(route.action, 'continue')
    router.recordTurn('also')
  }

  const after = router.active!
  assert.equal(after.turns, before.turns + 10)
  assert.equal(after.taskDescriptor, before.taskDescriptor)
  assert.equal(after.fingerprint.revision, before.fingerprint.revision)
  assert.equal(pathSignal(after, 'src/auth/token.ts').weight, beforePath.weight)
})

test('a genuinely repeated path observation reinforces the weighted fingerprint', () => {
  let now = 0
  const router = new TaskAgentRouter({ now: () => ++now })
  router.register('s1', 'fix auth token behavior', { activePaths: ['src/auth/token.ts'] })
  const before = pathSignal(router.active!, 'src/auth/token.ts')
  const beforeRevision = router.active!.fingerprint.revision

  router.recordTurn('', { activePaths: ['src/auth/token.ts'] })

  const after = router.active!
  assert.ok(pathSignal(after, 'src/auth/token.ts').weight > before.weight)
  assert.equal(after.fingerprint.revision, beforeRevision + 1)
})

test('semantic task vector cache survives a turn that does not change task identity', async () => {
  let now = 0
  let providerCalls = 0
  const provider: TaskEmbeddingProvider = {
    modelID: 'counting-test-provider',
    embed: async () => {
      providerCalls += 1
      return new Float32Array([1, 0, 0])
    },
  }
  const semantic = new SemanticTaskRouter(provider)
  const router = new TaskAgentRouter({ now: () => ++now })
  router.register('s1', 'fix auth token behavior', { activePaths: ['src/auth/token.ts'] })

  const first = await semantic.decide('check auth token handling', router.active!, [])
  assert.equal(first.agentEmbeddingCount, 1)
  assert.equal(providerCalls, 2)

  router.recordTurn('also')

  const second = await semantic.decide('check auth token handling', router.active!, [])
  assert.equal(second.agentEmbeddingCount, 0)
  assert.equal(providerCalls, 3)
})

test('meaningful new prompt evidence still decays older artifact evidence', () => {
  let now = 0
  const router = new TaskAgentRouter({ now: () => ++now })
  router.register('s1', 'fix auth token behavior', { activePaths: ['src/auth/token.ts'] })
  const before = pathSignal(router.active!, 'src/auth/token.ts').weight

  router.recordTurn('refine refresh behavior')

  const after = pathSignal(router.active!, 'src/auth/token.ts').weight
  assert.ok(after < before)
})

function pathSignal(agent: NonNullable<ReturnType<TaskAgentRouter['active']>>, path: string) {
  const signal = agent.fingerprint.paths.find((candidate) => candidate.value === path.toLowerCase())
  assert.ok(signal, `missing fingerprint path signal for ${path}`)
  return signal
}
