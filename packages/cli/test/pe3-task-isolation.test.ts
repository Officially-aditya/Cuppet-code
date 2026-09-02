import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TaskSessionRouter, type TaskSessionAdapter } from '../src/pe3/session-router.js'

test('fresh task session does not inherit source task active or touched paths', async () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  let currentID: string | undefined
  let created = 0

  // Simulate the real controller window where adapter.evidence() can still
  // describe the source task immediately after super.newSession() returns.
  const staleSourceEvidence = {
    activePaths: ['src/auth/token.ts'],
    touchedPaths: ['src/auth/token.ts'],
    recentSymbols: ['refreshToken'],
    workspaceEpoch: 7,
  }
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
    evidence: () => staleSourceEvidence,
  }

  const auth = await router.prepare('fix refresh token expiry in src/auth/token.ts', adapter)
  assert.equal(auth.action, 'create')
  assert.ok(router.active?.touchedPaths.includes('src/auth/token.ts'))

  const billing = await router.prepare(
    'separately, new task: implement invoice retry in src/billing/retry.ts',
    adapter,
  )

  assert.equal(billing.action, 'create')
  assert.notEqual(billing.sessionID, auth.sessionID)
  assert.equal(router.active?.activePaths.includes('src/auth/token.ts'), false)
  assert.equal(router.active?.touchedPaths.includes('src/auth/token.ts'), false)
  assert.equal(router.active?.recentSymbols.includes('refreshtoken'), false)
  assert.ok(router.active?.activePaths.includes('src/billing/retry.ts'))
  assert.equal(router.active?.workspaceEpoch, 7)
})
