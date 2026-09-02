import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pe3TuiNavigationDecision } from '../src/pe3-tui.js'

test('new task switch navigates exactly once to the routed session', () => {
  const status = {
    session: { id: 'task-b' },
    pe3: { routing: { sequence: 4, lastAction: 'create' } },
  }
  const first = pe3TuiNavigationDecision(
    status,
    { name: 'session', params: { sessionID: 'task-a' } },
    3,
  )
  assert.deepEqual(first, { observedSequence: 4, targetSessionID: 'task-b' })

  const repeated = pe3TuiNavigationDecision(
    status,
    { name: 'session', params: { sessionID: 'manually-selected' } },
    first.observedSequence,
  )
  assert.deepEqual(repeated, { observedSequence: 4 })
})

test('continuations advance sequence without forcing navigation', () => {
  const decision = pe3TuiNavigationDecision(
    {
      session: { id: 'task-a' },
      pe3: { routing: { sequence: 9, lastAction: 'continue' } },
    },
    { name: 'session', params: { sessionID: 'task-a' } },
    8,
  )
  assert.deepEqual(decision, { observedSequence: 9 })
})

test('reactivation does not navigate when TUI already shows the target', () => {
  const decision = pe3TuiNavigationDecision(
    {
      session: { id: 'task-a' },
      pe3: { routing: { sequence: 12, lastAction: 'reactivate' } },
    },
    { name: 'session', params: { sessionID: 'task-a' } },
    11,
  )
  assert.deepEqual(decision, { observedSequence: 12 })
})
