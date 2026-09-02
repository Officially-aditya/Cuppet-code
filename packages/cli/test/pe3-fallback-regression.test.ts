import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SemanticTaskRouter } from '../src/pe3/semantic-router.js'
import { TaskSessionRouter, type TaskSessionAdapter } from '../src/pe3/session-router.js'

test('unavailable semantic runtime never turns an ambiguous prompt into a split', async () => {
  const router = offlineSemanticRouter()
  const harness = adapterHarness()

  const first = await router.prepare('fix refresh token expiration', harness.adapter)
  const second = await router.prepare('implement organization migration support', harness.adapter)

  assert.equal(second.action, 'continue')
  assert.equal(second.sessionID, first.sessionID)
  assert.equal(harness.created, 1)
  assert.equal(router.stats().semanticFailures, 1)
})

test('explicit task-boundary language stays deterministic when semantic runtime is unavailable', async () => {
  const router = offlineSemanticRouter()
  const harness = adapterHarness()

  const first = await router.prepare('fix refresh token expiration', harness.adapter)
  const second = await router.prepare('unrelated new task: implement organization migration support', harness.adapter)

  assert.equal(second.action, 'create')
  assert.notEqual(second.sessionID, first.sessionID)
  assert.equal(harness.created, 2)
  assert.equal(router.stats().semanticFailures, 0)
})

function offlineSemanticRouter(): TaskSessionRouter {
  return new TaskSessionRouter(undefined, {
    semantic: new SemanticTaskRouter({
      modelID: 'offline-missing',
      embed: async () => {
        throw new Error('offline model not staged')
      },
    }),
  })
}

function adapterHarness(): {
  adapter: TaskSessionAdapter
  readonly created: number
} {
  let currentID: string | undefined
  let created = 0
  return {
    adapter: {
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
    },
    get created() {
      return created
    },
  }
}
