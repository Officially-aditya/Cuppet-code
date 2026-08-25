import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDeepSeekBenchmarkTarget } from './deepseek-benchmark.js'

test('DeepSeek benchmark target defaults to the existing DeepSeek route', () => {
  const previousProvider = process.env.CUPPET_DSH_PROVIDER
  const previousModel = process.env.CUPPET_DSH_MODEL
  delete process.env.CUPPET_DSH_PROVIDER
  delete process.env.CUPPET_DSH_MODEL
  try {
    assert.deepEqual(resolveDeepSeekBenchmarkTarget('deepseek-v4-flash'), {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      usesCuppetOpenAICodex: false,
    })
  } finally {
    if (previousProvider === undefined) delete process.env.CUPPET_DSH_PROVIDER
    else process.env.CUPPET_DSH_PROVIDER = previousProvider
    if (previousModel === undefined) delete process.env.CUPPET_DSH_MODEL
    else process.env.CUPPET_DSH_MODEL = previousModel
  }
})

test('DeepSeek benchmark target can select the OpenAI Codex route and model', () => {
  const previousProvider = process.env.CUPPET_DSH_PROVIDER
  const previousModel = process.env.CUPPET_DSH_MODEL
  process.env.CUPPET_DSH_PROVIDER = 'openai-codex'
  process.env.CUPPET_DSH_MODEL = 'gpt-5.6-luna'
  try {
    assert.deepEqual(resolveDeepSeekBenchmarkTarget('deepseek-v4-flash'), {
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      usesCuppetOpenAICodex: true,
    })
  } finally {
    if (previousProvider === undefined) delete process.env.CUPPET_DSH_PROVIDER
    else process.env.CUPPET_DSH_PROVIDER = previousProvider
    if (previousModel === undefined) delete process.env.CUPPET_DSH_MODEL
    else process.env.CUPPET_DSH_MODEL = previousModel
  }
})

