import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TaskSessionRouter } from '../src/pe3/session-router.js'

test('late path evidence is attributed to its originating dormant session', () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  router.bindSession('a', { activePaths: ['src/auth/token.ts'] }, 'auth task')
  router.bindSession('b', { activePaths: ['src/report/filter.ts'] }, 'report task')

  assert.equal(router.active?.sessionID, 'b')
  router.noteSessionPaths('a', ['src/auth/late-result.ts'])

  const a = agent(router, 'a')
  const b = agent(router, 'b')
  assert.ok(a.activePaths.includes('src/auth/late-result.ts'))
  assert.ok(a.touchedPaths.includes('src/auth/late-result.ts'))
  assert.equal(b.activePaths.includes('src/auth/late-result.ts'), false)
  assert.equal(b.touchedPaths.includes('src/auth/late-result.ts'), false)
  assert.equal(router.active?.sessionID, 'b')
})

test('workspace mutation invalidates every privileged task but keeps only the origin fresh', () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  router.bindSession('a', { touchedPaths: ['src/shared/config.ts'] }, 'task a')
  router.bindSession('b', { touchedPaths: ['src/shared/config.ts'] }, 'task b')

  router.noteSessionWorkspaceMutation('b', ['src/shared/config.ts'])

  const a = agent(router, 'a')
  const b = agent(router, 'b')
  assert.ok(a.stalePaths.includes('src/shared/config.ts'))
  assert.equal(b.stalePaths.includes('src/shared/config.ts'), false)
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
  assert.equal(b.activePaths.includes('src/auth/callback.ts'), false)
  assert.equal(b.fingerprint.revision, bRevision)
  assert.equal(router.active?.sessionID, 'b')
})

test('unregistered background-session evidence is ignored', () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  router.bindSession('foreground', { activePaths: ['src/app.ts'] }, 'foreground task')
  const before = agent(router, 'foreground')

  router.noteSessionPaths('cuppet-background-session', ['src/background/worker.ts'])
  router.noteSessionWorkspaceMutation('cuppet-background-session', ['src/background/worker.ts'])

  const after = agent(router, 'foreground')
  assert.deepEqual(after.activePaths, before.activePaths)
  assert.deepEqual(after.touchedPaths, before.touchedPaths)
  assert.equal(after.fingerprint.revision, before.fingerprint.revision)
})

test('interleaved task observations remain isolated regardless of event order', () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  router.bindSession('a', {}, 'task a')
  router.bindSession('b', {}, 'task b')
  router.bindSession('c', {}, 'task c')

  router.noteSessionPaths('a', ['src/a/one.ts'])
  router.noteSessionPaths('c', ['src/c/one.ts'])
  router.noteSessionPaths('b', ['src/b/one.ts'])
  router.noteSessionPaths('a', ['src/a/two.ts'])
  router.noteSessionPaths('c', ['src/c/two.ts'])

  assert.deepEqual(agent(router, 'a').touchedPaths, ['src/a/one.ts', 'src/a/two.ts'])
  assert.deepEqual(agent(router, 'b').touchedPaths, ['src/b/one.ts'])
  assert.deepEqual(agent(router, 'c').touchedPaths, ['src/c/one.ts', 'src/c/two.ts'])
  assert.equal(router.active?.sessionID, 'c')
})

function agent(router: TaskSessionRouter, sessionID: string) {
  const value = router.agents().find((candidate) => candidate.sessionID === sessionID)
  assert.ok(value, `missing task agent for ${sessionID}`)
  return value
}
