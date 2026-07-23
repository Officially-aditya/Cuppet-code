import assert from 'node:assert/strict'
import { test } from 'node:test'
import { totalTokenUsage } from '../src/usage.js'

test('token total does not double-count cache breakdowns', () => {
  assert.equal(totalTokenUsage({
    input: 55_433,
    output: 620,
    reasoning: 628,
    cacheRead: 91_643,
    cacheWrite: 0,
  }), 56_681)
})
