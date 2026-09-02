import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SemanticTaskRouter } from '../src/pe3/semantic-router.js'
import { TaskSessionRouter, type TaskSessionAdapter } from '../src/pe3/session-router.js'

test('unavailable semantic runtime never turns an ambiguous prompt into a split', async () => {
  const router = new TaskSessionRouter(undefined, {
    semantic: new SemanticTaskRouter({
      modelID: 'offline-missing',
      embed: async () => {
        throw new Error('offline model not staged')
      },
    }),
  })
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

  const first = await router.prepare('fix refresh token expiration', adapter)
  const second = await router.prepare('implement an unrelated sounding subsystem request', adapter)

  assert.equal(second.action, 'continue')
  assert.equal(second.sessionID, first.sessionID)
  assert.equal(created, 1)
  assert.equal(router.stats().semanticFailures, 1)
})
