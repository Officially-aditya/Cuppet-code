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

function model(
  providerID: string,
  modelID: string,
  tools: boolean,
  input: string[],
  output: string[],
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
    capabilities: { tools, input, output },
  }
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
