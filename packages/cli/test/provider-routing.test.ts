import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PreferenceStore, Preferences } from '../src/config/preferences.js'
import { CuppetController } from '../src/controller.js'
import type { OpenCodeGateway } from '../src/opencode/gateway.js'
import type { RuntimeAssets } from '../src/runtime/assets.js'
import type { RuntimePaths } from '../src/runtime/paths.js'
import type { IntegrationInfo, ModelInfo, ModelRef, SessionInfo } from '../src/types.js'

test('legacy Vertex selections migrate to the live OpenCode provider and use the common gateway', async () => {
  let preferencesValue: Preferences = {
    schema: 1,
    platform: 'vertex',
    primary: { providerID: 'vertex', modelID: 'gemini-test' },
    secondary: { providerID: 'vertex', modelID: 'gemini-test' },
    backgroundPaused: true,
    lastSessionByProject: {},
  }
  const prompts: Array<{ sessionID: string; text: string; delivery: string }> = []
  const gateway = {
    async listModels() {
      return [
        model('google-vertex', 'gemini-test', true, ['text'], ['text']),
        model('google-vertex', 'summary-test', false, ['text'], ['text']),
        model('google-vertex', 'image-test', false, ['image'], ['image']),
        model('google', 'gemini-api-test', true, ['text'], ['text']),
      ]
    },
    async listIntegrations(): Promise<IntegrationInfo[]> {
      return [{
        id: 'google-vertex',
        name: 'Vertex',
        methods: [{ type: 'env', names: ['GOOGLE_APPLICATION_CREDENTIALS'] }],
        connections: [{ type: 'env', label: 'ADC' }],
      }]
    },
    onEvent() { return () => undefined },
    startEvents() {},
    async createSession(selected: ModelRef) { return session(selected) },
    async prompt(sessionID: string, text: string, delivery: string) {
      prompts.push({ sessionID, text, delivery })
    },
    async close() {},
  } as unknown as OpenCodeGateway
  const preferences = {
    get value() { return structuredClone(preferencesValue) },
    async update(change: Partial<Omit<Preferences, 'schema'>>) {
      preferencesValue = { ...preferencesValue, ...change }
      return structuredClone(preferencesValue)
    },
    async setLastSession(projectID: string, sessionID: string) {
      preferencesValue.lastSessionByProject[projectID] = sessionID
    },
  } as unknown as PreferenceStore
  const controller = new CuppetController({
    gateway,
    preferences,
    paths: { projectID: 'project', projectRealpath: process.cwd() } as RuntimePaths,
    assets: {} as RuntimeAssets,
    interactive: true,
  })

  await controller.initialize()

  assert.deepEqual(controller.snapshot.primary, { providerID: 'google-vertex', modelID: 'gemini-test' })
  assert.deepEqual(controller.snapshot.secondary, { providerID: 'google-vertex', modelID: 'gemini-test' })
  assert.equal(preferencesValue.provider, 'vertex')
  assert.deepEqual(preferencesValue.primary, controller.snapshot.primary)
  assert.deepEqual(
    controller.modelsForPlatform('vertex', 'primary').map((item) => item.modelID),
    ['gemini-test'],
  )
  assert.deepEqual(
    controller.modelsForPlatform('vertex', 'secondary').map((item) => item.modelID),
    ['gemini-test'],
  )
  assert.deepEqual(controller.modelsForPlatform('google', 'primary').map((item) => item.modelID), ['gemini-api-test'])

  await controller.submit('Read package.json and summarize it.')
  assert.equal(prompts.length, 1)
  assert.equal(prompts[0]?.sessionID, 'session')
  assert.equal(prompts[0]?.delivery, 'queue')
  assert.match(prompts[0]?.text ?? '', /Read package\.json/)

  await controller.close()
})

test('live providers, including NVIDIA and unknown future IDs, switch and persist without provider plumbing', async () => {
  let preferencesValue: Preferences = {
    schema: 1,
    provider: 'future-provider',
    backgroundPaused: true,
    lastSessionByProject: {},
  }
  const gateway = {
    async listModels() {
      return [
        model('future-provider', 'future-coder', true, ['text'], ['text']),
        model('nvidia', 'nim-coder', true, ['text'], ['text']),
        model('nvidia', 'nim-image', true, ['image'], ['image']),
        model('nvidia', 'nim-no-tools', false, ['text'], ['text']),
        model('google-vertex', 'vertex-coder', true, ['text'], ['text']),
        model('google-vertex-anthropic', 'vertex-anthropic-coder', true, ['text'], ['text']),
        model('azure', 'azure-coder', true, ['text'], ['text']),
        model('openai', 'openai-coder', true, ['text'], ['text']),
      ]
    },
    async listIntegrations(): Promise<IntegrationInfo[]> {
      return [
        integration('future-provider', 'Future Provider'),
        integration('nvidia', 'NVIDIA'),
        integration('google-vertex', 'Vertex'),
        integration('google-vertex-anthropic', 'Vertex Anthropic'),
        integration('azure', 'Azure'),
        integration('openai', 'OpenAI'),
      ]
    },
    onEvent() { return () => undefined },
    startEvents() {},
    async close() {},
  } as unknown as OpenCodeGateway
  const preferences = {
    get value() { return structuredClone(preferencesValue) },
    async update(change: Partial<Omit<Preferences, 'schema'>>) {
      preferencesValue = { ...preferencesValue, ...change }
      return structuredClone(preferencesValue)
    },
    async setLastSession() {},
  } as unknown as PreferenceStore
  const controller = new CuppetController({
    gateway,
    preferences,
    paths: { projectID: 'project', projectRealpath: process.cwd() } as RuntimePaths,
    assets: {} as RuntimeAssets,
    interactive: true,
  })

  await controller.initialize()
  const catalog = controller.providerCatalog()
  assert.ok(catalog.some((provider) => provider.id === 'future-provider'))
  assert.ok(catalog.some((provider) => provider.id === 'nvidia'))
  assert.equal(catalog.find((provider) => provider.id === 'vertex')?.specialization, 'vertex')
  assert.deepEqual(
    controller.modelsForProvider('nvidia', 'primary').map((item) => item.modelID),
    ['nim-coder'],
  )
  assert.deepEqual(
    controller.modelsForProvider('vertex', 'primary').map((item) => `${item.providerID}/${item.modelID}`),
    ['google-vertex/vertex-coder', 'google-vertex-anthropic/vertex-anthropic-coder'],
  )
  assert.deepEqual(
    controller.modelsForProvider('openai', 'primary').map((item) => `${item.providerID}/${item.modelID}`),
    ['azure/azure-coder', 'openai/openai-coder'],
  )

  await controller.selectProvider('nvidia')
  assert.equal(controller.snapshot.provider, 'nvidia')
  assert.equal(preferencesValue.provider, 'nvidia')
  assert.deepEqual(controller.snapshot.primary, { providerID: 'nvidia', modelID: 'nim-coder' })
  await assert.rejects(
    controller.selectModel('primary', { providerID: 'nvidia', modelID: 'nim-image' }),
    /does not support text coding tools/,
  )

  await controller.selectProvider('future-provider')
  assert.equal(controller.snapshot.provider, 'future-provider')
  assert.equal(preferencesValue.provider, 'future-provider')
  await controller.close()
})

function model(
  providerID: string,
  modelID: string,
  tools: boolean,
  input: string[],
  output: string[],
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

function session(selected: ModelRef): SessionInfo {
  return {
    id: 'session',
    title: 'Test session',
    model: selected,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    updated: Date.now(),
  }
}
