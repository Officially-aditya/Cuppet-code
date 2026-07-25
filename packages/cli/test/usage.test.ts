import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatTokenCount, totalTokenUsage } from '../src/usage.js'

test('token total does not double-count cache breakdowns', () => {
  assert.equal(totalTokenUsage({
    input: 55_433,
    output: 620,
    reasoning: 628,
    cacheRead: 91_643,
    cacheWrite: 0,
  }), 56_681)
})

test('formatTokenCount formats token numbers compactly', () => {
  assert.equal(formatTokenCount(0), '0')
  assert.equal(formatTokenCount(-100), '0')
  assert.equal(formatTokenCount(NaN), '0')
  assert.equal(formatTokenCount(500), '500')
  assert.equal(formatTokenCount(999), '999')
  assert.equal(formatTokenCount(1_000), '1k')
  assert.equal(formatTokenCount(1_500), '1.5k')
  assert.equal(formatTokenCount(23_555_989), '23.5M')
  assert.equal(formatTokenCount(1_290_000_000), '1.2B')
})

