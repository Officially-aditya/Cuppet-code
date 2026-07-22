import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ModelV2Info, Provider as LegacyProvider } from '@opencode-ai/sdk/v2'
import { buildVariantBridge } from '../src/opencode/variant-bridge.js'

test('variant bridge restores live OpenAI effort metadata without losing a model mode', () => {
  const bridge = buildVariantBridge(
    [model({ variants: [], body: { reasoning: { mode: 'pro' } } })],
    [provider({
      high: {
        reasoningEffort: 'high',
        reasoningSummary: 'auto',
        include: ['reasoning.encrypted_content'],
        apiKey: 'must-not-survive',
      },
    })],
  )

  assert.deepEqual(bridge, {
    schema: 1,
    models: [{
      providerID: 'openai',
      modelID: 'gpt-test-pro',
      variants: [{
        id: 'high',
        headers: {},
        body: {
          reasoning: { mode: 'pro', effort: 'high', summary: 'auto' },
          include: ['reasoning.encrypted_content'],
        },
      }],
    }],
  })
  assert.doesNotMatch(JSON.stringify(bridge), /must-not-survive|apiKey/)
})

test('variant bridge leaves variants already present in v2 untouched', () => {
  const bridge = buildVariantBridge(
    [model({ variants: [{ id: 'high', headers: {}, body: { reasoning: { effort: 'high' } } }], body: {} })],
    [provider({ high: { reasoningEffort: 'high' } })],
  )
  assert.deepEqual(bridge.models, [])
})

function model(input: { variants: ModelV2Info['variants']; body: Record<string, unknown> }): ModelV2Info {
  return {
    id: 'gpt-test-pro',
    providerID: 'openai',
    name: 'GPT Test Pro',
    api: { id: 'gpt-test', type: 'aisdk', package: '@ai-sdk/openai' },
    capabilities: { tools: true, input: ['text'], output: ['text'] },
    request: { headers: {}, body: input.body },
    variants: input.variants,
    time: { released: 0 },
    cost: [],
    status: 'active',
    enabled: true,
    limit: { context: 128_000, output: 16_000 },
  }
}

function provider(variants: Record<string, Record<string, unknown>>): LegacyProvider {
  return {
    id: 'openai',
    name: 'OpenAI',
    source: 'api',
    env: [],
    options: {},
    models: {
      'gpt-test-pro': {
        id: 'gpt-test-pro',
        providerID: 'openai',
        api: { id: 'gpt-test', url: '', npm: '@ai-sdk/openai' },
        name: 'GPT Test Pro',
        capabilities: {
          temperature: false,
          reasoning: true,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 128_000, output: 16_000 },
        status: 'active',
        options: {},
        headers: {},
        release_date: '',
        variants,
      },
    },
  }
}
