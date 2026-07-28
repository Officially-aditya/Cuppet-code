import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PreferenceStore, Preferences } from '../src/config/preferences.js'
import { CuppetController } from '../src/controller.js'
import type { OpenCodeGateway } from '../src/opencode/gateway.js'
import type { RuntimeAssets } from '../src/runtime/assets.js'
import type { RuntimePaths } from '../src/runtime/paths.js'
import type { AgentEvent, ModelInfo, SessionInfo } from '../src/types.js'

test('interactive permission requests remain pending for the native TUI', async () => {
  let listener: ((event: AgentEvent) => void) | undefined
  const replies: Array<{ requestID: string; reply: string }> = []
  const gateway = {
    async listModels() { return [model()] },
    async listIntegrations() { return [] },
    onEvent(value: (event: AgentEvent) => void) {
      listener = value
      return () => { listener = undefined }
    },
    startEvents() {},
    async getSession() { return session() },
    async replyPermission(_sessionID: string, requestID: string, reply: string) {
      replies.push({ requestID, reply })
    },
    async close() {},
  } as unknown as OpenCodeGateway
  const preferencesValue: Preferences = {
    schema: 1,
    platform: 'openai',
    primary: { providerID: 'openai', modelID: 'gpt-test' },
    backgroundPaused: true,
    lastSessionByProject: { project: 'session' },
  }
  const preferences = {
    get value() { return structuredClone(preferencesValue) },
  } as unknown as PreferenceStore
  const controller = new CuppetController({
    gateway,
    preferences,
    paths: { projectID: 'project' } as RuntimePaths,
    assets: {} as RuntimeAssets,
    interactive: true,
  })

  try {
    await controller.initialize()
    listener?.({
      type: 'permission',
      request: { id: 'permission-1', sessionID: 'session', action: 'edit', resources: ['src/app.ts'] },
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(replies, [])
    assert.equal(controller.snapshot.running, true)
  } finally {
    await controller.close()
  }
})

function model(): ModelInfo {
  return {
    providerID: 'openai',
    modelID: 'gpt-test',
    name: 'GPT Test',
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
