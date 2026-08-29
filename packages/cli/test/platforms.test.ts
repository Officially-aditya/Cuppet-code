import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildProviderCatalog,
  integrationMatchesPlatform,
  integrationMatchesProvider,
  modelMatchesPlatform,
  modelMatchesProvider,
  missingCodingAgentCapabilities,
  PROVIDER_OVERRIDES,
} from '../src/platforms.js'
import type { IntegrationInfo, ModelInfo } from '../src/types.js'

test('platform model groups include Azure, Gemini, and Vertex AI without crossing vendors', () => {
  assert.equal(modelMatchesPlatform({ providerID: 'anthropic' }, 'anthropic'), true)
  assert.equal(modelMatchesPlatform({ providerID: 'azure' }, 'openai'), true)
  assert.equal(modelMatchesPlatform({ providerID: 'google' }, 'google'), true)
  assert.equal(modelMatchesPlatform({ providerID: 'google-vertex' }, 'vertex'), true)
  assert.equal(modelMatchesPlatform({ providerID: 'google-vertex-anthropic' }, 'vertex'), true)
  assert.equal(modelMatchesPlatform({ providerID: 'opencode' }, 'opencode'), true)
  assert.equal(modelMatchesPlatform({ providerID: 'anthropic' }, 'openai'), false)
  assert.equal(modelMatchesPlatform({ providerID: 'google-vertex' }, 'google'), false)
  assert.equal(modelMatchesPlatform({ providerID: 'google' }, 'vertex'), false)
})

test('platform authentication groups recognize advertised provider integrations', () => {
  assert.equal(integrationMatchesPlatform({ id: 'google', name: 'Google Gemini' }, 'google'), true)
  assert.equal(integrationMatchesPlatform({ id: 'google-vertex', name: 'Vertex' }, 'vertex'), true)
  assert.equal(integrationMatchesPlatform({ id: 'google-vertex-anthropic', name: 'Vertex (Anthropic)' }, 'vertex'), true)
  assert.equal(integrationMatchesPlatform({ id: 'azure', name: 'Microsoft Azure' }, 'openai'), true)
  assert.equal(integrationMatchesPlatform({ id: 'anthropic', name: 'Anthropic' }, 'google'), false)
  assert.equal(integrationMatchesPlatform({ id: 'google-vertex', name: 'Vertex' }, 'google'), false)
  assert.equal(integrationMatchesPlatform({ id: 'google', name: 'Google' }, 'vertex'), false)
  assert.equal(integrationMatchesPlatform({ id: 'google-vertex-anthropic', name: 'Vertex (Anthropic)' }, 'anthropic'), false)
})

test('provider catalog discovers unknown providers and NVIDIA from live OpenCode data', () => {
  const models = [
    model('future-provider', 'future-coder', true),
    model('nvidia', 'nim-coder', true),
    model('nvidia', 'nim-image', true, ['image'], ['image']),
  ]
  const integrations = [integration('future-provider', 'Future Provider'), integration('nvidia', 'NVIDIA')]
  const catalog = buildProviderCatalog(models, integrations)
  const future = catalog.find((provider) => provider.id === 'future-provider')
  const nvidia = catalog.find((provider) => provider.id === 'nvidia')

  assert.equal(future?.label, 'Future Provider')
  assert.deepEqual(future?.integrationIds, ['future-provider'])
  assert.equal(future?.capabilities.codingAgent, true)
  assert.equal(nvidia?.label, 'NVIDIA')
  assert.deepEqual(nvidia?.integrationIds, ['nvidia'])
  assert.equal(PROVIDER_OVERRIDES.nvidia, undefined)
  assert.equal(modelMatchesProvider({ providerID: 'nvidia' }, nvidia!), true)
  assert.equal(integrationMatchesProvider(integrations[1]!, nvidia!), true)
})

test('provider capability validation exposes tool-calling and streaming gaps', () => {
  const [textOnly] = buildProviderCatalog(
    [model('text-only', 'model', false, ['text'], ['text'])],
    [integration('text-only', 'Text Only')],
  )
  const [notStreaming] = buildProviderCatalog(
    [model('not-streaming', 'model', true, ['text'], ['text'], false)],
    [integration('not-streaming', 'Not Streaming')],
  )

  assert.deepEqual(missingCodingAgentCapabilities(textOnly!), ['tool calling'])
  assert.deepEqual(missingCodingAgentCapabilities(notStreaming!), ['streaming'])
  assert.equal(textOnly?.capabilities.codingAgent, false)
  assert.equal(notStreaming?.capabilities.codingAgent, false)
})

test('OpenAI aliases and Vertex integrations remain grouped under special descriptors', () => {
  const catalog = buildProviderCatalog(
    [model('azure', 'azure-coder', true), model('google-vertex-anthropic', 'vertex-coder', true)],
    [integration('azure-openai', 'Azure OpenAI'), integration('google-vertex', 'Vertex'), integration('google-vertex-anthropic', 'Vertex Anthropic')],
  )
  const openai = catalog.find((provider) => provider.id === 'openai')
  const vertex = catalog.find((provider) => provider.id === 'vertex')

  assert.deepEqual(openai?.integrationIds, ['openai', 'azure', 'azure-openai'])
  assert.equal(modelMatchesProvider({ providerID: 'azure' }, openai!), true)
  assert.equal(integrationMatchesProvider({ id: 'azure-openai', name: 'Azure OpenAI' }, openai!), true)
  assert.equal(vertex?.specialization, 'vertex')
  assert.equal(modelMatchesProvider({ providerID: 'google-vertex-anthropic' }, vertex!), true)
  assert.equal(integrationMatchesProvider({ id: 'google-vertex', name: 'Vertex' }, vertex!), true)
})

function model(
  providerID: string,
  modelID: string,
  tools: boolean,
  input = ['text'],
  output = ['text'],
  streaming = true,
): ModelInfo {
  return {
    providerID,
    modelID,
    name: modelID,
    context: 128_000,
    output: 8_192,
    enabled: true,
    status: 'active',
    inputCost: 1,
    outputCost: 1,
    capabilities: { tools, streaming, input, output },
  }
}

function integration(id: string, name: string): IntegrationInfo {
  return { id, name, methods: [], connections: [] }
}
