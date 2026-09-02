import assert from 'node:assert/strict'
import test from 'node:test'
import { TaskAgentRouter } from '../src/pe3/task-agents.js'

test('same-task continuation stays on the active agent', () => {
  const router = new TaskAgentRouter({ now: () => 1 })
  router.register('s-auth', 'Fix refresh token expiry in src/auth/session.ts', {
    activePaths: ['src/auth/session.ts'],
    recentSymbols: ['refreshToken'],
  })

  const route = router.route('Also update the tests for refreshToken')
  assert.equal(route.action, 'continue')
  assert.equal(route.agent.sessionID, 's-auth')
})

test('large cached continuation is not split merely because context is old or large', () => {
  let now = 0
  const router = new TaskAgentRouter({ now: () => ++now })
  router.register('s-auth', 'Investigate refresh token expiration and rotation behavior')
  for (let index = 0; index < 50; index += 1) {
    router.recordTurn(`Continue refresh token rotation investigation case ${index}`)
  }

  const route = router.route('What about the retry path when refresh token rotation fails?')
  assert.equal(route.action, 'continue')
  assert.equal(route.agent.turns, 51)
  assert.equal(route.agent.cacheEpoch, 0)
})

test('underspecified follow-up defaults to the current agent', () => {
  const router = new TaskAgentRouter()
  router.register('s-a', 'Fix authentication callback state validation')

  const route = router.route('Can you fix that too?')
  assert.equal(route.action, 'continue')
  assert.match(route.reason, /continuation|ambiguous/)
})

test('clear unrelated task creates a fresh task agent route', () => {
  const router = new TaskAgentRouter()
  router.register('s-auth', 'Fix refresh token expiry in src/auth/session.ts', {
    activePaths: ['src/auth/session.ts'],
    touchedPaths: ['src/auth/oauth.ts'],
  })

  const route = router.route('Separately, add CSV export pagination in src/analytics/export.ts')
  assert.equal(route.action, 'create')
  assert.match(route.reason, /strong task mismatch/)
})

test('disjoint path components do not become lexical continuation evidence', () => {
  const router = new TaskAgentRouter()
  router.register('s-auth', 'fix auth parsing in src/auth/parser.ts')

  const route = router.route('implement weather parsing in src/weather/parser.ts')
  assert.equal(route.action, 'create')
  assert.equal(route.affinity.pathOverlap, 0)
  assert.equal(route.affinity.termOverlap, 1)
})

test('weak lexical mismatch resists false splitting', () => {
  const router = new TaskAgentRouter()
  router.register('s-a', 'Refactor account settings persistence and validation')

  const route = router.route('Check whether this still handles errors correctly')
  assert.equal(route.action, 'continue')
})

test('dormant agent is reactivated when active task strongly mismatches', () => {
  const router = new TaskAgentRouter()
  const auth = router.register('s-auth', 'Fix refresh token expiration handling', {
    activePaths: ['src/auth/session.ts'],
    recentSymbols: ['refreshToken'],
  })
  router.register('s-csv', 'Implement analytics CSV export pagination', {
    activePaths: ['src/analytics/export.ts'],
    recentSymbols: ['exportCsv'],
  })

  const route = router.route('Go back to refreshToken expiration in src/auth/session.ts')
  assert.equal(route.action, 'reactivate')
  assert.equal(route.agent.id, auth.id)
  assert.equal(route.agent.sessionID, 's-auth')
})

test('workspace changes mark dormant task-local paths stale without deleting the agent', () => {
  const router = new TaskAgentRouter()
  const auth = router.register('s-auth', 'Fix refresh token expiration handling', {
    activePaths: ['src/auth/session.ts'],
  })
  router.register('s-other', 'Implement analytics export', {
    activePaths: ['src/analytics/export.ts'],
  })

  router.noteWorkspaceChange(['src/auth/session.ts'])

  const dormant = router.list().find((agent) => agent.id === auth.id)
  assert.deepEqual(dormant?.stalePaths, ['src/auth/session.ts'])
  assert.equal(dormant?.cacheEpoch, 1)

  const route = router.route('Go back to src/auth/session.ts and refresh token expiration')
  assert.equal(route.action, 'reactivate')
  assert.deepEqual(route.refreshPaths, ['src/auth/session.ts'])
})

test('refresh acknowledgement clears stale privilege only after evidence is refreshed', () => {
  const router = new TaskAgentRouter()
  const auth = router.register('s-auth', 'Fix refresh token expiration handling', {
    activePaths: ['src/auth/session.ts'],
  })
  router.noteWorkspaceChange(['src/auth/session.ts'])
  assert.deepEqual(router.active?.stalePaths, ['src/auth/session.ts'])

  router.acknowledgeRefresh(auth.id, ['src/auth/session.ts'])
  assert.deepEqual(router.active?.stalePaths, [])
})

test('dormant agents are inert state and do not execute anything by being registered', () => {
  let clockReads = 0
  const router = new TaskAgentRouter({ now: () => ++clockReads })
  router.register('s-a', 'Authentication task')
  router.register('s-b', 'Analytics task')

  const before = clockReads
  const agents = router.list()
  assert.equal(agents.length, 2)
  assert.equal(clockReads, before)
})
