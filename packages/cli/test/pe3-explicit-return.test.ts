import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SemanticTaskRouter, type TaskEmbeddingProvider } from '../src/pe3/semantic-router.js'
import { TaskSessionRouter, type TaskSessionAdapter } from '../src/pe3/session-router.js'

test('explicit return with a vocabulary gap semantically reactivates the dormant session', async () => {
  const router = semanticSessionRouter()
  const harness = adapterHarness()

  const auth = await router.prepare('fix refresh token expiration', harness.adapter)
  await router.prepare('separately, new task: build csv export pagination', harness.adapter)
  const returned = await router.prepare('go back to the credential renewal problem', harness.adapter)

  assert.equal(returned.action, 'reactivate')
  assert.equal(returned.sessionID, auth.sessionID)
  assert.equal(harness.created, 2)
  assert.deepEqual(harness.resumed, [auth.sessionID])
  assert.equal(router.stats().semanticReactivated, 1)
})

test('explicit return with no decisive dormant match stays active and cannot create a fresh agent', async () => {
  const router = semanticSessionRouter()
  const harness = adapterHarness()

  await router.prepare('fix refresh token expiration', harness.adapter)
  const analytics = await router.prepare('separately, new task: build csv export pagination', harness.adapter)
  const returned = await router.prepare('go back to websocket observability cleanup', harness.adapter)

  assert.equal(returned.action, 'continue')
  assert.equal(returned.sessionID, analytics.sessionID)
  assert.equal(harness.created, 2)
  assert.deepEqual(harness.resumed, [])
  const stats = router.stats()
  assert.equal(stats.semanticEscalations, 1)
  assert.equal(stats.semanticCreated, 1)
  assert.equal(stats.created, 2)
})

test('deterministic explicit-return fast path still wins without semantic inference', async () => {
  const provider: TaskEmbeddingProvider = {
    modelID: 'must-not-run',
    embed: async () => {
      throw new Error('semantic embedding should not be called')
    },
  }
  const router = new TaskSessionRouter(undefined, { semantic: new SemanticTaskRouter(provider) })
  const harness = adapterHarness()

  const auth = await router.prepare('fix refresh token expiry in src/auth/token.ts', harness.adapter)
  await router.prepare('separately, new task: add csv export in src/analytics/export.ts', harness.adapter)
  const returned = await router.prepare('go back to src/auth/token.ts', harness.adapter)

  assert.equal(returned.action, 'reactivate')
  assert.equal(returned.sessionID, auth.sessionID)
  assert.equal(router.stats().semanticEscalations, 0)
})

function semanticSessionRouter(): TaskSessionRouter {
  return new TaskSessionRouter(undefined, { semantic: new SemanticTaskRouter(keywordProvider()) })
}

function keywordProvider(): TaskEmbeddingProvider {
  return {
    modelID: 'synthetic-minilm',
    embed: async (text) => {
      const value = text.toLowerCase()
      if (value.includes('refresh token') || value.includes('credential renewal') || value.includes('oauth')) {
        return new Float32Array([1, 0, 0])
      }
      if (value.includes('csv') || value.includes('export pagination')) return new Float32Array([0, 1, 0])
      return new Float32Array([0.2, 0.2, 0.9591663])
    },
  }
}

function adapterHarness(): {
  adapter: TaskSessionAdapter
  resumed: string[]
  readonly created: number
} {
  let currentID: string | undefined
  let created = 0
  const resumed: string[] = []
  const adapter: TaskSessionAdapter = {
    current: () => currentID ? { id: currentID } : undefined,
    create: async () => {
      created += 1
      currentID = `s${created}`
      return { id: currentID }
    },
    resume: async (sessionID) => {
      resumed.push(sessionID)
      currentID = sessionID
      return { id: sessionID }
    },
    evidence: () => ({}),
  }
  return {
    adapter,
    resumed,
    get created() {
      return created
    },
  }
}
