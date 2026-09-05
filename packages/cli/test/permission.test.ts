import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('safe Bash checks are approved once while unsafe commands remain visible', async () => {
  let listener: ((event: AgentEvent) => void) | undefined
  const replies: Array<{ requestID: string; reply: string }> = []
  const forwarded: AgentEvent[] = []
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
  const preferences = testPreferences()
  const controller = new CuppetController({
    gateway,
    preferences,
    paths: { projectID: 'project' } as RuntimePaths,
    assets: {} as RuntimeAssets,
    interactive: true,
  })

  try {
    await controller.initialize()
    controller.onAgentEvent((event) => forwarded.push(event))
    listener?.({
      type: 'permission',
      request: { id: 'safe', sessionID: 'session', action: 'bash', resources: ['git status'] },
    })
    await flushEvents()
    assert.deepEqual(replies, [{ requestID: 'safe', reply: 'once' }])
    assert.deepEqual([...forwarded], [])

    listener?.({
      type: 'permission',
      request: { id: 'unsafe', sessionID: 'session', action: 'bash', resources: ['npm test'] },
    })
    await flushEvents()
    assert.deepEqual(replies, [{ requestID: 'safe', reply: 'once' }])
    assert.deepEqual(forwarded.map((event) => event.type), ['permission'])
  } finally {
    await controller.close()
  }
})

test('/auto enables guarded workspace approvals only for the active session', async () => {
  const project = await mkdtemp(join(tmpdir(), 'cuppet-auto-controller-'))
  let listener: ((event: AgentEvent) => void) | undefined
  const replies: Array<{ requestID: string; reply: string }> = []
  const forwarded: AgentEvent[] = []
  const gateway = {
    async listModels() { return [model()] },
    async listIntegrations() { return [] },
    onEvent(value: (event: AgentEvent) => void) {
      listener = value
      return () => { listener = undefined }
    },
    startEvents() {},
    async getSession(sessionID: string) { return session(sessionID) },
    async replyPermission(_sessionID: string, requestID: string, reply: string) {
      replies.push({ requestID, reply })
    },
    async close() {},
  } as unknown as OpenCodeGateway
  const controller = new CuppetController({
    gateway,
    preferences: testPreferences(),
    paths: { projectID: 'project', projectRealpath: project } as RuntimePaths,
    assets: {} as RuntimeAssets,
    interactive: true,
  })

  try {
    await controller.initialize()
    assert.equal(controller.snapshot.autoMode, false)
    await controller.adoptSession('session')
    assert.deepEqual(await controller.setAutoApprovalEnabled(true), { enabled: true, sessionID: 'session' })
    assert.equal(controller.snapshot.autoMode, true)
    controller.onAgentEvent((event) => forwarded.push(event))

    listener?.({
      type: 'permission',
      request: { id: 'workspace-edit', sessionID: 'session', action: 'edit', resources: ['src/app.ts'] },
    })
    await waitFor(() => replies.length === 1)
    assert.deepEqual(replies, [{ requestID: 'workspace-edit', reply: 'once' }])
    assert.deepEqual([...forwarded], [])

    listener?.({
      type: 'permission',
      request: { id: 'other-session-edit', sessionID: 'other-session', action: 'edit', resources: ['src/app.ts'] },
    })
    await waitFor(() => forwarded.length === 1)
    assert.deepEqual(replies, [{ requestID: 'workspace-edit', reply: 'once' }])
    assert.deepEqual(forwarded.map((event) => event.type), ['permission'])

    listener?.({
      type: 'permission',
      request: { id: 'protected-edit', sessionID: 'session', action: 'edit', resources: ['.env'] },
    })
    await waitFor(() => forwarded.length === 2)
    assert.deepEqual(replies, [{ requestID: 'workspace-edit', reply: 'once' }])
    assert.deepEqual(forwarded.map((event) => event.type), ['permission', 'permission'])
  } finally {
    await controller.close()
    await rm(project, { recursive: true, force: true })
  }
})

function testPreferences(): PreferenceStore {
  const value: Preferences = {
    schema: 1,
    platform: 'openai',
    primary: { providerID: 'openai', modelID: 'gpt-test' },
    backgroundPaused: true,
    lastSessionByProject: { project: 'session' },
  }
  return {
    get value() { return structuredClone(value) },
  } as unknown as PreferenceStore
}

async function flushEvents(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for controller event')
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

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

function session(id = 'session'): SessionInfo {
  return {
    id,
    title: 'Test session',
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    updated: Date.now(),
  }
}
