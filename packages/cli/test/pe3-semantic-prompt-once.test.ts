import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SemanticTaskRouter, type TaskEmbeddingProvider } from '../src/pe3/semantic-router.js'
import { TaskAgentRouter } from '../src/pe3/task-agents.js'

test('one semantic decision never embeds the incoming prompt more than once', async () => {
  const prompt = 'implement a completely different data export capability'
  const calls: string[] = []
  const provider: TaskEmbeddingProvider = {
    modelID: 'counting-provider',
    embed: async (text) => {
      calls.push(text)
      return text === prompt ? new Float32Array([0, 1]) : new Float32Array([1, 0])
    },
  }
  const active = new TaskAgentRouter().register('a', 'fix authentication renewal')
  const dormant = Array.from({ length: 6 }, (_, index) =>
    new TaskAgentRouter().register(`d${index}`, `historic task ${index}`),
  )

  const result = await new SemanticTaskRouter(provider).decide(prompt, active, dormant)

  assert.equal(result.promptEmbeddingCount, 1)
  assert.equal(calls.filter((value) => value === prompt).length, 1)
})
