import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SemanticTaskRouter, type TaskEmbeddingProvider } from '../src/pe3/semantic-router.js'
import { TaskSessionRouter, type TaskSessionAdapter } from '../src/pe3/session-router.js'

test('shared generic vocabulary does not override a semantically novel task', async () => {
  const router = semanticRouter()
  const harness = adapterHarness()

  const first = await router.prepare('fix the auth service retry handler', harness)
  const second = await router.prepare('add a report service retry dashboard', harness)

  assert.equal(first.action, 'create')
  assert.equal(second.action, 'create')
  assert.notEqual(first.sessionID, second.sessionID)
})

test('same task with almost no lexical overlap preserves active cache', async () => {
  const router = semanticRouter()
  const harness = adapterHarness()

  const first = await router.prepare('fix refresh token expiration', harness)
  const second = await router.prepare('repair the oauth credential renewal lifecycle', harness)

  assert.equal(second.action, 'continue')
  assert.equal(second.sessionID, first.sessionID)
})

test('close dormant candidates do not steal an ambiguous request', async () => {
  const provider: TaskEmbeddingProvider = {
    modelID: 'adversarial-close-race',
    embed: async (text) => {
      const value = text.toLowerCase()
      if (value.includes('first dormant')) return new Float32Array([1, 0])
      if (value.includes('second dormant')) return new Float32Array([0.98, 0.2])
      if (value.includes('ambiguous semantic request')) return new Float32Array([0.99, 0.1])
      return new Float32Array([0.99, 0.1])
    },
  }
  const semantic = new SemanticTaskRouter(provider, { activeContinueMin: 0.9999 })
  const activeRouter = new TaskSessionRouter(undefined, { semantic })
  const harness = adapterHarness()

  const active = await activeRouter.prepare('active context identity', harness)
  await activeRouter.prepare('separately, new task: first dormant identity', harness)
  await activeRouter.prepare('separately, new task: second dormant identity', harness)
  const current = harness.currentID!
  const result = await activeRouter.prepare('ambiguous semantic request wording', harness)

  assert.equal(result.action, 'continue')
  assert.equal(result.sessionID, current)
  assert.notEqual(result.sessionID, active.sessionID)
})

function semanticRouter(): TaskSessionRouter {
  const provider: TaskEmbeddingProvider = {
    modelID: 'adversarial-minilm',
    embed: async (text) => {
      const value = text.toLowerCase()
      if (value.includes('auth service') || value.includes('refresh token') || value.includes('credential renewal') || value.includes('oauth')) {
        return new Float32Array([1, 0, 0])
      }
      if (value.includes('report service') || value.includes('dashboard')) return new Float32Array([0, 1, 0])
      return new Float32Array([0, 0, 1])
    },
  }
  return new TaskSessionRouter(undefined, { semantic: new SemanticTaskRouter(provider) })
}

function adapterHarness(): TaskSessionAdapter & { currentID?: string } {
  let currentID: string | undefined
  let created = 0
  return {
    get currentID() {
      return currentID
    },
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
}
