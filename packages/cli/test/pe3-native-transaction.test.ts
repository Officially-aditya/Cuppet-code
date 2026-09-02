import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TaskSessionRouter, type TaskSessionAdapter } from '../src/pe3/session-router.js'

test('failed NEW handoff can restore the source with no target fingerprint or switch telemetry', async () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  const harness = adapterHarness()

  const source = await router.prepare('fix refresh expiry in src/auth/token.ts', harness.adapter)
  const before = router.checkpoint()
  const provisional = await router.prepare('implement weather parser in src/weather/parser.ts', harness.adapter)
  const after = router.checkpoint()

  assert.equal(provisional.action, 'create')
  assert.notEqual(provisional.sessionID, source.sessionID)
  assert.equal(router.active?.sessionID, provisional.sessionID)
  assert.equal(after.stats.switches, before.stats.switches + 1)

  router.restoreCheckpoint(before)
  harness.select(source.sessionID)

  assert.equal(router.active?.sessionID, source.sessionID)
  assert.equal(router.agents().some((agent) => agent.sessionID === provisional.sessionID), false)
  assert.deepEqual(router.stats(), before.stats)

  const next = await router.prepare('continue fixing src/auth/token.ts', harness.adapter)
  assert.equal(next.action, 'continue')
  assert.equal(next.sessionID, source.sessionID)
})

test('failed dormant RESUME handoff restores dormant fingerprint and keeps source active', async () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  const harness = adapterHarness()

  const auth = await router.prepare('fix refresh expiry in src/auth/token.ts', harness.adapter)
  const dashboard = await router.prepare('implement dashboard chart in src/dashboard/view.ts', harness.adapter)
  assert.equal(dashboard.action, 'create')

  const before = router.checkpoint()
  const dormantBefore = before.router.agents.find((agent) => agent.sessionID === auth.sessionID)
  assert.ok(dormantBefore)

  const provisional = await router.prepare('go back to refresh expiry in src/auth/token.ts', harness.adapter)
  assert.equal(provisional.action, 'reactivate')
  assert.equal(provisional.sessionID, auth.sessionID)
  assert.notDeepEqual(
    router.agents().find((agent) => agent.sessionID === auth.sessionID)?.fingerprint,
    dormantBefore.fingerprint,
  )

  router.restoreCheckpoint(before)
  harness.select(dashboard.sessionID)

  const dormantAfterAbort = router.agents().find((agent) => agent.sessionID === auth.sessionID)
  assert.deepEqual(dormantAfterAbort, dormantBefore)
  assert.equal(router.active?.sessionID, dashboard.sessionID)
  assert.deepEqual(router.stats(), before.stats)

  const next = await router.prepare('continue dashboard chart in src/dashboard/view.ts', harness.adapter)
  assert.equal(next.action, 'continue')
  assert.equal(next.sessionID, dashboard.sessionID)
})

test('committing a prepared checkpoint applies one routing transition without double counting', async () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  const harness = adapterHarness()

  await router.prepare('fix refresh expiry in src/auth/token.ts', harness.adapter)
  const before = router.checkpoint()
  const provisional = await router.prepare('implement weather parser in src/weather/parser.ts', harness.adapter)
  const committed = router.checkpoint()
  assert.equal(provisional.action, 'create')

  router.restoreCheckpoint(before)
  router.restoreCheckpoint(committed)
  const once = router.stats()
  router.restoreCheckpoint(committed)
  const twice = router.stats()

  assert.deepEqual(twice, once)
  assert.equal(once.switches, before.stats.switches + 1)
  assert.equal(router.active?.sessionID, provisional.sessionID)
})

function adapterHarness(): {
  adapter: TaskSessionAdapter
  select(sessionID: string): void
} {
  let currentID: string | undefined
  let sequence = 0
  const adapter: TaskSessionAdapter = {
    current: () => currentID ? { id: currentID } : undefined,
    create: async () => {
      sequence += 1
      currentID = `s${sequence}`
      return { id: currentID }
    },
    resume: async (sessionID) => {
      currentID = sessionID
      return { id: sessionID }
    },
    evidence: () => ({}),
  }
  return {
    adapter,
    select(sessionID: string) { currentID = sessionID },
  }
}
