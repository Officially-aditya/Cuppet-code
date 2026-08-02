import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CHECKPOINT_BOUNDARIES,
  completedPairKeys,
  pendingPairs,
  validateCompletedPairs,
} from '../src/benchmark/ab-stm-compaction-recovery.js'

const orders = [
  ['control', 'stm_only'],
  ['stm_only', 'control'],
] as const

test('resume skips completed pairs and reruns the interrupted arm at every checkpoint boundary', () => {
  const completed = [{ repeat: 1, arm: 'control' as const }]
  for (const boundary of CHECKPOINT_BOUNDARIES) {
    const interrupted = pendingPairs(orders, completed)
    assert.deepEqual(interrupted, [
      { repeat: 1, arm: 'stm_only' },
      { repeat: 2, arm: 'stm_only' },
      { repeat: 2, arm: 'control' },
    ], boundary)

    const afterArmFinished = boundary === 'arm.finished'
      ? [...completed, { repeat: 1, arm: 'stm_only' as const }]
      : completed
    const resumed = pendingPairs(orders, afterArmFinished)
    if (boundary === 'arm.finished') {
      assert.deepEqual(resumed, [
        { repeat: 2, arm: 'stm_only' },
        { repeat: 2, arm: 'control' },
      ], boundary)
    }
  }
})

test('checkpoint identity validation rejects duplicates and preserves prior pairs', () => {
  const completed = [
    { repeat: 1, arm: 'control' as const },
    { repeat: 2, arm: 'stm_only' as const },
  ]
  const keys = completedPairKeys(completed)
  assert.equal(keys.has('1:control'), true)
  assert.equal(keys.has('1:stm_only'), false)
  assert.doesNotThrow(() => validateCompletedPairs(completed, 2))
  assert.throws(
    () => validateCompletedPairs([...completed, { repeat: 1, arm: 'control' as const }], 2),
    /duplicate completed pair 1:control/,
  )
})
