import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeDeepSeekEvents } from './deepseek-harness.js'

test('summarizes disjoint uncached and cached DeepSeek token counters', () => {
  const usage = summarizeDeepSeekEvents([
    {
      type: 'assistant/message',
      data: {
        usage: { inputTokens: 12, outputTokens: 5, reasoningTokens: 3, cacheReadTokens: 40 },
        message: { content: [{ type: 'tool-call' }, { type: 'text', text: 'working' }] },
      },
    },
    {
      type: 'assistant/message',
      data: {
        usage: { inputTokens: 7, outputTokens: 2 },
        message: { content: [{ type: 'text', text: 'done' }] },
      },
    },
  ])

  assert.deepEqual(usage, {
    modelCalls: 2,
    inputTokens: 19,
    outputTokens: 7,
    reasoningTokens: 3,
    cacheReadTokens: 40,
    cacheWriteTokens: 0,
    uncachedInputTokens: 19,
    totalModelTokens: 29,
    toolCalls: 1,
  })
})

test('ignores non-assistant events and incomplete usage fields', () => {
  assert.deepEqual(summarizeDeepSeekEvents([
    { type: 'tool/result', data: { usage: { inputTokens: 900 } } },
    { type: 'assistant/message', data: { message: { content: [] } } },
  ]), {
    modelCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    uncachedInputTokens: 0,
    totalModelTokens: 0,
    toolCalls: 0,
  })
})
