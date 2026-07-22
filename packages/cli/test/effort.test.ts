import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PreferenceStore, Preferences } from '../src/config/preferences.js'
import { CuppetController } from '../src/controller.js'
import type { OpenCodeGateway } from '../src/opencode/gateway.js'
import type { RuntimeAssets } from '../src/runtime/assets.js'
import type { RuntimePaths } from '../src/runtime/paths.js'
import type { ModelInfo, ModelRef, SessionInfo } from '../src/types.js'

test('effort selection uses live variants, persists the choice, and updates the active session', async () => {
  const models: ModelInfo[] = [
    model(),
    model('low'),
    model('high'),
  ]
  let preferencesValue: Preferences = {
    schema: 1,
    platform: 'openai',
    primary: { providerID: 'openai', modelID: 'gpt-test' },
    secondary: { providerID: 'openai', modelID: 'gpt-test' },
    backgroundPaused: true,
    lastSessionByProject: { project: 'session' },
  }
  const switched: ModelRef[] = []
  const gateway = {
    async listModels() { return models },
    async listIntegrations() { return [] },
    onEvent() { return () => undefined },
    startEvents() {},
    async getSession() { return session() },
    async switchModel(_sessionID: string, selected: ModelRef) { switched.push(selected) },
    async close() {},
  } as unknown as OpenCodeGateway
  const preferences = {
    get value() { return structuredClone(preferencesValue) },
    async update(change: Partial<Omit<Preferences, 'schema'>>) {
      preferencesValue = { ...preferencesValue, ...change }
      return structuredClone(preferencesValue)
    },
  } as unknown as PreferenceStore
  const controller = new CuppetController({
    gateway,
    preferences,
    paths: { projectID: 'project' } as RuntimePaths,
    assets: {} as RuntimeAssets,
    interactive: true,
  })

  await controller.initialize()
  switched.length = 0

  assert.deepEqual(controller.effortOptions(), ['low', 'high'])
  assert.equal(await controller.selectEffort('primary', 'HIGH'), 'high')
  assert.deepEqual(controller.snapshot.primary, {
    providerID: 'openai',
    modelID: 'gpt-test',
    variant: 'high',
  })
  assert.deepEqual(preferencesValue.primary, controller.snapshot.primary)
  assert.deepEqual(switched, [controller.snapshot.primary])
  await assert.rejects(controller.selectEffort('primary', 'extreme'), /Available: low, high/)

  await controller.close()
})

function model(variant?: string): ModelInfo {
  return {
    providerID: 'openai',
    modelID: 'gpt-test',
    ...(variant ? { variant } : {}),
    name: `GPT Test${variant ? ` [${variant}]` : ''}`,
    context: 128_000,
    output: 16_000,
    enabled: true,
    status: 'active',
    inputCost: 1,
    outputCost: 1,
    capabilities: { tools: true, input: ['text'], output: ['text'] },
  }
}

function session(): SessionInfo {
  return {
    id: 'session',
    title: 'Test session',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    updated: Date.now(),
  }
}
