import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pe3InputBreakdown, routeChangedSession } from '../src/pe3/controller.js'
import { TaskSessionRouter, type TaskSessionAdapter } from '../src/pe3/session-router.js'

test('persistent A → A → B → B → C → A sequence preserves coherent sessions and reactivates A', async () => {
  const router = new TaskSessionRouter()
  const harness = adapterHarness()

  const a1 = await router.prepare('fix refresh token expiry in src/auth/token.ts', harness.adapter)
  assert.equal(a1.action, 'create')
  const sessionA = a1.sessionID

  const a2 = await router.prepare('also update the refresh token tests in src/auth/token.test.ts', harness.adapter)
  assert.equal(a2.action, 'continue')
  assert.equal(a2.sessionID, sessionA)

  const b1 = await router.prepare('separately, new task: add analytics csv export in src/analytics/export.ts', harness.adapter)
  assert.equal(b1.action, 'create')
  assert.notEqual(b1.sessionID, sessionA)
  const sessionB = b1.sessionID

  const b2 = await router.prepare('also add analytics export tests', harness.adapter)
  assert.equal(b2.action, 'continue')
  assert.equal(b2.sessionID, sessionB)

  const c1 = await router.prepare('separately, new task: implement billing invoice retry in src/billing/retry.ts', harness.adapter)
  assert.equal(c1.action, 'create')
  assert.notEqual(c1.sessionID, sessionB)

  const a3 = await router.prepare('go back to the refresh token issue in src/auth/token.ts', harness.adapter)
  assert.equal(a3.action, 'reactivate')
  assert.equal(a3.sessionID, sessionA)
  assert.deepEqual(harness.resumed, [sessionA])

  const stats = router.stats()
  assert.equal(stats.created, 3)
  assert.equal(stats.reactivated, 1)
  assert.equal(stats.continuations, 2)
  assert.equal(stats.switches, 4)
})

test('ambiguous and underspecified follow-ups stay on the active cache-friendly session', async () => {
  const router = new TaskSessionRouter()
  const harness = adapterHarness()

  const first = await router.prepare('refactor provider discovery in src/platforms.ts', harness.adapter)
  const second = await router.prepare('can you check that?', harness.adapter)
  const third = await router.prepare('what about the tests?', harness.adapter)

  assert.equal(second.action, 'continue')
  assert.equal(third.action, 'continue')
  assert.equal(second.sessionID, first.sessionID)
  assert.equal(third.sessionID, first.sessionID)
  assert.equal(harness.created, 1)
  assert.deepEqual(harness.resumed, [])
})

test('dormant task receives stale-path refresh hint after another task changes its working set', async () => {
  const router = new TaskSessionRouter()
  const harness = adapterHarness()

  const a = await router.prepare('fix auth refresh token logic in src/auth/token.ts', harness.adapter)
  await router.prepare('separately, new task: build analytics csv export in src/analytics/export.ts', harness.adapter)

  // The active analytics task changes a file that the dormant auth task had
  // privileged. Analytics knows the new contents; auth must refresh on return.
  router.noteWorkspaceMutation(['src/auth/token.ts'])

  const resumed = await router.prepare('go back to auth refresh token in src/auth/token.ts', harness.adapter)
  assert.equal(resumed.action, 'reactivate')
  assert.equal(resumed.sessionID, a.sessionID)
  assert.deepEqual(resumed.refreshPaths, ['src/auth/token.ts'])
  assert.match(resumed.prompt, /PE3 task resume/)
  assert.match(resumed.prompt, /current workspace truth/)
  assert.match(resumed.prompt, /src\/auth\/token\.ts/)
})

test('dormant agents are inert until a matching prompt explicitly reactivates them', async () => {
  const router = new TaskSessionRouter()
  const harness = adapterHarness()

  const a = await router.prepare('repair oauth callback in src/auth/callback.ts', harness.adapter)
  await router.prepare('separately, new task: add report filters in src/report/filter.ts', harness.adapter)

  for (let index = 0; index < 8; index += 1) {
    const continuation = await router.prepare('also adjust report filtering behavior', harness.adapter)
    assert.equal(continuation.action, 'continue')
  }

  assert.equal(harness.resumed.includes(a.sessionID), false)
  assert.equal(harness.created, 2)
})

test('cache telemetry separates cached and uncached input without double-counting cache counters', () => {
  assert.deepEqual(pe3InputBreakdown({
    input: 10_000,
    output: 500,
    reasoning: 200,
    cacheRead: 7_500,
    cacheWrite: 400,
  }), {
    cachedInput: 7_500,
    uncachedInput: 2_500,
    cacheWrite: 400,
  })

  // Defensive clamp for inconsistent provider counters.
  assert.deepEqual(pe3InputBreakdown({
    input: 100,
    output: 0,
    reasoning: 0,
    cacheRead: 120,
    cacheWrite: 0,
  }), {
    cachedInput: 100,
    uncachedInput: 0,
    cacheWrite: 0,
  })
})

test('routeChangedSession only flags a real task-local session switch', () => {
  const route = {
    action: 'continue' as const,
    sessionID: 's1',
    prompt: 'x',
    reason: 'same task',
    refreshPaths: [],
  }
  assert.equal(routeChangedSession(route, 's1'), false)
  assert.equal(routeChangedSession({ ...route, action: 'create', sessionID: 's2' }, 's1'), true)
  assert.equal(routeChangedSession(route), false)
})

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
