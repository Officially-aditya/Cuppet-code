import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TaskSessionRouter } from '../src/pe3/session-router.js'

test('late read-only path evidence is attributed as observed, not touched', () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  router.bindSession('a', { activePaths: ['src/auth/token.ts'] }, 'auth task')
  router.bindSession('b', { activePaths: ['src/report/filter.ts'] }, 'report task')

  assert.equal(router.active?.sessionID, 'b')
  router.noteSessionObservedPaths('a', ['src/auth/late-result.ts'])

  const a = agent(router, 'a')
  const b = agent(router, 'b')
  assert.ok(a.activePaths.includes('src/auth/late-result.ts'))
  assert.equal(a.touchedPaths.includes('src/auth/late-result.ts'), false)
  assert.equal(pathSignal(a, 'src/auth/late-result.ts')?.source, 'active')
  assert.equal(b.activePaths.includes('src/auth/late-result.ts'), false)
  assert.equal(b.touchedPaths.includes('src/auth/late-result.ts'), false)
  assert.equal(router.active?.sessionID, 'b')
})

test('workspace mutation records touched evidence and keeps only the origin fresh', () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  router.bindSession('a', { touchedPaths: ['src/shared/config.ts'] }, 'task a')
  router.bindSession('b', { activePaths: ['src/shared/config.ts'] }, 'task b')
  const observedWeight = pathSignal(agent(router, 'b'), 'src/shared/config.ts')?.weight ?? 0

  router.noteSessionWorkspaceMutation('b', ['src/shared/config.ts'])

  const a = agent(router, 'a')
  const b = agent(router, 'b')
  assert.ok(a.stalePaths.includes('src/shared/config.ts'))
  assert.equal(b.stalePaths.includes('src/shared/config.ts'), false)
  assert.ok(b.touchedPaths.includes('src/shared/config.ts'))
  assert.equal(pathSignal(b, 'src/shared/config.ts')?.source, 'touched')
  assert.ok((pathSignal(b, 'src/shared/config.ts')?.weight ?? 0) > observedWeight)
  assert.equal(router.active?.sessionID, 'b')
})

test('late mutation from a dormant task does not contaminate the foreground fingerprint', () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  router.bindSession('a', { activePaths: ['src/auth/token.ts'] }, 'auth task')
  router.bindSession('b', { activePaths: ['src/report/filter.ts'] }, 'report task')
  const bRevision = agent(router, 'b').fingerprint.revision

  router.noteSessionWorkspaceMutation('a', ['src/auth/callback.ts'])

  const a = agent(router, 'a')
  const b = agent(router, 'b')
  assert.ok(a.activePaths.includes('src/auth/callback.ts'))
  assert.ok(a.touchedPaths.includes('src/auth/callback.ts'))
  assert.equal(b.activePaths.includes('src/auth/callback.ts'), false)
  assert.equal(b.fingerprint.revision, bRevision)
  assert.equal(router.active?.sessionID, 'b')
})

test('unregistered background-session evidence is ignored', () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  router.bindSession('foreground', { activePaths: ['src/app.ts'] }, 'foreground task')
  const before = agent(router, 'foreground')

  router.noteSessionObservedPaths('cuppet-background-session', ['src/background/worker.ts'])
  router.noteSessionWorkspaceMutation('cuppet-background-session', ['src/background/worker.ts'])

  const after = agent(router, 'foreground')
  assert.deepEqual(after.activePaths, before.activePaths)
  assert.deepEqual(after.touchedPaths, before.touchedPaths)
  assert.equal(after.fingerprint.revision, before.fingerprint.revision)
})

test('interleaved read/search observations remain isolated and never become touches', () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  router.bindSession('a', {}, 'task a')
  router.bindSession('b', {}, 'task b')
  router.bindSession('c', {}, 'task c')

  router.noteSessionObservedPaths('a', ['src/a/one.ts'])
  router.noteSessionObservedPaths('c', ['src/c/one.ts'])
  router.noteSessionObservedPaths('b', ['src/b/one.ts'])
  router.noteSessionObservedPaths('a', ['src/a/two.ts'])
  router.noteSessionObservedPaths('c', ['src/c/two.ts'])

  assert.deepEqual(agent(router, 'a').activePaths, ['src/a/one.ts', 'src/a/two.ts'])
  assert.deepEqual(agent(router, 'b').activePaths, ['src/b/one.ts'])
  assert.deepEqual(agent(router, 'c').activePaths, ['src/c/one.ts', 'src/c/two.ts'])
  assert.deepEqual(agent(router, 'a').touchedPaths, [])
  assert.deepEqual(agent(router, 'b').touchedPaths, [])
  assert.deepEqual(agent(router, 'c').touchedPaths, [])
  assert.equal(router.active?.sessionID, 'c')
})

test('legacy noteSessionPaths remains an observed-only compatibility alias', () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  router.bindSession('a', {}, 'task a')
  router.noteSessionPaths('a', ['src/read-only.ts'])

  const a = agent(router, 'a')
  assert.deepEqual(a.activePaths, ['src/read-only.ts'])
  assert.deepEqual(a.touchedPaths, [])
  assert.equal(pathSignal(a, 'src/read-only.ts')?.source, 'active')
})

function agent(router: TaskSessionRouter, sessionID: string) {
  const value = router.agents().find((candidate) => candidate.sessionID === sessionID)
  assert.ok(value, `missing task agent for ${sessionID}`)
  return value
}

function pathSignal(agentState: ReturnType<typeof agent>, path: string) {
  return agentState.fingerprint.paths.find((signal) => signal.value === path)
}
