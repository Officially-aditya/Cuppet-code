import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OpenCodeEventNormalizer } from '../src/opencode/gateway.js'

test('legacy OpenCode message events stream assistant text without echoing user prompts or duplicating snapshots', () => {
  const normalizer = new OpenCodeEventNormalizer()

  assert.deepEqual(normalizer.normalize(event('message.updated', {
    sessionID: 'session',
    info: { id: 'user-message', sessionID: 'session', role: 'user' },
  })), [])
  assert.deepEqual(normalizer.normalize(event('message.part.updated', {
    sessionID: 'session',
    part: {
      id: 'user-part',
      sessionID: 'session',
      messageID: 'user-message',
      type: 'text',
      text: 'do not echo me',
    },
  })), [])

  normalizer.normalize(event('message.updated', {
    sessionID: 'session',
    info: { id: 'assistant-message', sessionID: 'session', role: 'assistant' },
  }))
  assert.deepEqual(normalizer.normalize(event('message.part.updated', {
    sessionID: 'session',
    part: {
      id: 'assistant-part',
      sessionID: 'session',
      messageID: 'assistant-message',
      type: 'text',
      text: 'Hello',
    },
  })), [{ type: 'text-delta', sessionID: 'session', text: 'Hello' }])
  assert.deepEqual(normalizer.normalize(event('message.part.delta', {
    sessionID: 'session',
    messageID: 'assistant-message',
    partID: 'assistant-part',
    field: 'text',
    delta: ' world',
  })), [{ type: 'text-delta', sessionID: 'session', text: ' world' }])
  assert.deepEqual(normalizer.normalize(event('message.part.updated', {
    sessionID: 'session',
    part: {
      id: 'assistant-part',
      sessionID: 'session',
      messageID: 'assistant-message',
      type: 'text',
      text: 'Hello world',
      time: { start: 1, end: 2 },
    },
  })), [])
})

test('legacy OpenCode tool, permission, and usage events map into the Cuppet event contract exactly once', () => {
  const normalizer = new OpenCodeEventNormalizer()
  assert.deepEqual(normalizer.normalize(event('message.part.updated', {
    sessionID: 'session',
    part: {
      id: 'tool-part',
      sessionID: 'session',
      messageID: 'assistant-message',
      type: 'tool',
      callID: 'call-1',
      tool: 'edit',
      state: { status: 'pending', input: {}, raw: '' },
    },
  })), [])
  const running = event('message.part.updated', {
    sessionID: 'session',
    part: {
      id: 'tool-part',
      sessionID: 'session',
      messageID: 'assistant-message',
      type: 'tool',
      callID: 'call-1',
      tool: 'edit',
      state: {
        status: 'running',
        input: { filePath: 'src/index.ts' },
        title: 'Editing src/index.ts',
        time: { start: 1 },
      },
    },
  })
  assert.deepEqual(normalizer.normalize(running), [
    {
      type: 'tool-start',
      sessionID: 'session',
      callID: 'call-1',
      name: 'edit',
      input: { filePath: 'src/index.ts' },
    },
    {
      type: 'tool-progress',
      sessionID: 'session',
      callID: 'call-1',
      message: 'Editing src/index.ts',
    },
  ])
  assert.deepEqual(normalizer.normalize(running), [])

  assert.deepEqual(normalizer.normalize(event('permission.asked', {
    id: 'permission-1',
    sessionID: 'session',
    permission: 'edit',
    patterns: ['src/index.ts'],
    always: ['src/**'],
    metadata: { tool: 'edit' },
  })), [{
    type: 'permission',
    request: {
      id: 'permission-1',
      sessionID: 'session',
      action: 'edit',
      resources: ['src/index.ts'],
      save: ['src/**'],
      metadata: { tool: 'edit' },
    },
  }])

  const completed = event('message.part.updated', {
    sessionID: 'session',
    part: {
      id: 'tool-part',
      sessionID: 'session',
      messageID: 'assistant-message',
      type: 'tool',
      callID: 'call-1',
      tool: 'edit',
      state: {
        status: 'completed',
        input: { filePath: 'src/index.ts' },
        output: 'Done',
        title: 'Edited',
        metadata: { filePath: 'src/index.ts' },
        time: { start: 1, end: 2 },
      },
    },
  })
  assert.deepEqual(normalizer.normalize(completed), [{
    type: 'tool-end',
    sessionID: 'session',
    callID: 'call-1',
    success: true,
    outputPaths: ['src/index.ts'],
  }])
  assert.deepEqual(normalizer.normalize(completed), [])

  const stepFinishEvent = event('message.part.updated', {
    sessionID: 'session',
    part: {
      id: 'step-finish',
      sessionID: 'session',
      messageID: 'assistant-message',
      type: 'step-finish',
      cost: 0.25,
      tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
    },
  })

  assert.deepEqual(normalizer.normalize(stepFinishEvent), [{
    type: 'usage',
    sessionID: 'session',
    usage: { input: 10, output: 4, reasoning: 2, cacheRead: 3, cacheWrite: 1 },
    cost: 0.25,
  }])

  // Duplicate step-finish part update should emit nothing
  assert.deepEqual(normalizer.normalize(stepFinishEvent), [])

  // Subsequent session.step.ended for the same step should emit nothing
  assert.deepEqual(normalizer.normalize(event('session.step.ended', {
    sessionID: 'session',
    id: 'step-finish',
    cost: 0.25,
    tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
  })), [])
})

function event(type: string, properties: Record<string, unknown>) {
  return { directory: '/project', payload: { type, properties } }
}
