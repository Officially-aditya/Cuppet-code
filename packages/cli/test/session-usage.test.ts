import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PreferenceStore, Preferences } from '../src/config/preferences.js'
import { CuppetController } from '../src/controller.js'
import type { OpenCodeGateway } from '../src/opencode/gateway.js'
import type { RuntimeAssets } from '../src/runtime/assets.js'
import type { RuntimePaths } from '../src/runtime/paths.js'
import type { AgentEvent, ModelInfo, SessionInfo, TokenUsage } from '../src/types.js'

test('foreground usage starts at zero whenever a session becomes active', async () => {
  const sessions = new Map<string, SessionInfo>([
    ['history', session('history', usage(10, 2, 1, 4, 1), 2)],
  ])
  let nextSession = 1
  let onEvent: ((event: AgentEvent) => void) | undefined
  let preferencesValue: Preferences = {
    schema: 1,
    platform: 'openai',
    primary: { providerID: 'openai', modelID: 'gpt-test' },
    backgroundPaused: true,
    lastSessionByProject: { project: 'history' },
  }
  const gateway = {
    async listModels() { return [model()] },
    async listIntegrations() { return [] },
    onEvent(listener: (event: AgentEvent) => void) {
      onEvent = listener
      return () => { onEvent = undefined }
    },
    startEvents() {},
    async getSession(id: string) { return cloneSession(sessions.get(id)!) },
    async createSession() {
      const id = `fresh-${nextSession++}`
      const created = session(id, usage(), 0)
      sessions.set(id, created)
      return cloneSession(created)
    },
    async switchModel() {},
    async close() {},
  } as unknown as OpenCodeGateway
  const preferences = {
    get value() { return structuredClone(preferencesValue) },
    async update(change: Partial<Omit<Preferences, 'schema'>>) {
      preferencesValue = { ...preferencesValue, ...change }
      return structuredClone(preferencesValue)
    },
    async setLastSession(projectID: string, sessionID: string) {
      preferencesValue = {
        ...preferencesValue,
        lastSessionByProject: { ...preferencesValue.lastSessionByProject, [projectID]: sessionID },
      }
    },
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
    assertUsage(controller, usage(), 0)

    sessions.set('history', session('history', usage(14, 3, 1, 6, 1), 2.5))
    onEvent?.({ type: 'idle', sessionID: 'history' })
    await flushEvents()
    assertUsage(controller, usage(4, 1, 0, 2, 0), 0.5)

    const fresh = await controller.newSession()
    assertUsage(controller, usage(), 0)

    sessions.set(fresh.id, session(fresh.id, usage(5, 2, 0, 1, 0), 0.2))
    onEvent?.({ type: 'idle', sessionID: fresh.id })
    await flushEvents()
    assertUsage(controller, usage(5, 2, 0, 1, 0), 0.2)

    await controller.resume('history')
    assertUsage(controller, usage(), 0)

    sessions.set('history', session('history', usage(16, 4, 1, 6, 1), 3))
    onEvent?.({ type: 'idle', sessionID: 'history' })
    await flushEvents()
    assertUsage(controller, usage(2, 1, 0, 0, 0), 0.5)
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

function session(id: string, tokens: TokenUsage, cost: number): SessionInfo {
  return { id, title: id, tokens, cost, updated: Date.now() }
}

function usage(input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheWrite = 0): TokenUsage {
  return { input, output, reasoning, cacheRead, cacheWrite }
}

function cloneSession(value: SessionInfo): SessionInfo {
  return { ...value, tokens: { ...value.tokens } }
}

function assertUsage(controller: CuppetController, expected: TokenUsage, cost: number): void {
  assert.deepEqual(controller.snapshot.foregroundUsage, expected)
  assert.equal(controller.snapshot.foregroundCost, cost)
}

async function flushEvents(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}
