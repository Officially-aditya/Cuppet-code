import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pe3InputBreakdown } from '../src/pe3/controller.js'

test('PE3 treats cache reads as an input breakdown rather than extra tokens', () => {
  const breakdown = pe3InputBreakdown({
    input: 40_000,
    output: 2_000,
    reasoning: 1_000,
    cacheRead: 31_000,
    cacheWrite: 4_000,
  })
  assert.deepEqual(breakdown, {
    cachedInput: 31_000,
    uncachedInput: 9_000,
    cacheWrite: 4_000,
  })
})
