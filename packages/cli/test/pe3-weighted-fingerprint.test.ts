import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TaskAgentRouter } from '../src/pe3/task-agents.js'

test('weak task terms decay and fingerprint collections stay bounded', () => {
  let now = 0
  const router = new TaskAgentRouter({ now: () => ++now })
  router.register('s1', 'alpha beta gamma initial request')
  for (let index = 0; index < 80; index += 1) {
    router.recordTurn(`unique-term-${index} another-term-${index} third-term-${index}`)
  }
  const active = router.active!
  assert.ok(active.fingerprint.terms.length <= 32)
  assert.ok(active.fingerprint.paths.length <= 16)
  assert.ok(active.fingerprint.symbols.length <= 16)
  assert.equal(active.fingerprint.terms.some((signal) => signal.value === 'alpha'), false)
})
