import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { CuppetControlClient } from '../src/control/client.js'
import { CuppetControlServer, createControlAddress } from '../src/control/server.js'
import type { NativeRoutingAttachment } from '../src/pe3/native-envelope.js'

test('launch-scoped control API authenticates and exposes diagnostics', async (t) => {
  const runtime = await mkdtemp(join(process.cwd(), '.control-test-'))
  const paths = { runtime } as never
  let selectedPlatform = 'openai'
  let nativeAgent = 'build'
  let autoMode = false
  const nativeRoutes: Array<{ sessionID: string; prompt: string; attachments: NativeRoutingAttachment[] }> = []
  const controller = {
    async status() { return { product: 'Cuppet' } },
    async doctor() { return { healthy: true } },
    get snapshot() { return { background: { paused: false }, platform: selectedPlatform, planMode: nativeAgent === 'plan' } },
    get autoApprovalEnabled() { return autoMode },
    async setAutoApprovalEnabled(enabled: boolean) {
      autoMode = enabled
      return { enabled: autoMode, sessionID: 'session' }
    },
    syncNativeAgent(agent: string) { nativeAgent = agent; return nativeAgent === 'plan' },
    modelsForPlatform(platform: string) { return platform === 'vertex' ? [{ id: 'gemini' }] : [] },
    integrationsForPlatform(platform: string) {
      return platform === 'vertex' ? [{ id: 'google-vertex', connections: [{ type: 'provider' }] }] : []
    },
    async selectPlatform(platform: string) { selectedPlatform = platform },
    async routeNativePrompt(sessionID: string, prompt: string, attachments: NativeRoutingAttachment[] = []) {
      nativeRoutes.push({ sessionID, prompt, attachments })
      return {
        rerouted: true,
        action: 'create',
        sourceSessionID: sessionID,
        targetSessionID: 'task-b',
        reason: 'strong task mismatch',
        sequence: 2,
        refreshPaths: [],
      }
    },
  } as never
  const address = createControlAddress(paths)
  let remoteRunning = false
  const remote = {
    async start() {
      remoteRunning = true
      return { running: true, hostId: 'host_test', deviceName: 'test-host' }
    },
    stop() {
      remoteRunning = false
      return { running: false }
    },
    status() {
      return remoteRunning ? { running: true, hostId: 'host_test', deviceName: 'test-host' } : { running: false }
    },
  }
  let server: CuppetControlServer
  try {
    server = await CuppetControlServer.start(controller, paths, address, { remote })
  } catch (error) {
    await rm(runtime, { recursive: true, force: true })
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('sandbox does not permit Unix-domain sockets')
      return
    }
    throw error
  }
  try {
    const client = new CuppetControlClient(address.socket, address.token)
    assert.deepEqual(await client.call('status'), { product: 'Cuppet' })
    assert.deepEqual(await client.call('doctor'), { healthy: true })
    assert.deepEqual(await client.call('background.status'), { paused: false })
    assert.deepEqual(await client.call('auto.status'), { enabled: false })
    assert.deepEqual(await client.call('auto.set', { enabled: true }), { enabled: true, sessionID: 'session' })
    assert.deepEqual(await client.call('auto.status'), { enabled: true })
    const platforms = await client.call<{ selected: string; options: Array<{ value: string; connected: boolean }> }>('platform.list')
    assert.equal(platforms.selected, 'openai')
    assert.equal(platforms.options.find((option) => option.value === 'vertex')?.connected, true)
    assert.equal((await client.call<{ selected: string }>('platform.select', { platform: 'vertex' })).selected, 'vertex')
    assert.deepEqual(await client.call('plan.set', { agent: 'plan' }), { enabled: true, agent: 'plan' })
    assert.deepEqual(await client.call('plan.toggle'), { enabled: false, agent: 'build' })
    assert.deepEqual(await client.call('remote.status'), { running: false })
    assert.deepEqual(await client.call('remote.start'), { running: true, hostId: 'host_test', deviceName: 'test-host' })
    assert.deepEqual(await client.call('remote.status'), { running: true, hostId: 'host_test', deviceName: 'test-host' })
    assert.deepEqual(await client.call('remote.stop'), { running: false })
    assert.deepEqual(
      await client.call('pe3.route-native', {
        sessionID: 'task-a',
        prompt: '  new task: billing retry  ',
        attachments: [
          { type: 'file', filename: 'dashboard.png', mime: 'image/png' },
          { type: 'file', filename: 'requirements.pdf', mime: 'application/pdf' },
        ],
      }),
      {
        rerouted: true,
        action: 'create',
        sourceSessionID: 'task-a',
        targetSessionID: 'task-b',
        reason: 'strong task mismatch',
        sequence: 2,
        refreshPaths: [],
      },
    )
    assert.deepEqual(nativeRoutes, [{
      sessionID: 'task-a',
      prompt: '  new task: billing retry  ',
      attachments: [
        { type: 'file', filename: 'dashboard.png', mime: 'image/png' },
        { type: 'file', filename: 'requirements.pdf', mime: 'application/pdf' },
      ],
    }])
    await assert.rejects(
      () => client.call('pe3.route-native', {
        sessionID: 'task-a',
        prompt: 'route this image',
        attachments: [{ type: 'file', filename: 'x.png', mime: 'image/png', url: 'data:image/png;base64,AAAA' }],
      }),
      /unsupported field url/,
    )
    assert.equal(nativeRoutes.length, 1)
    assert.equal((await stat(address.socket)).mode & 0o777, 0o600)
    await assert.rejects(() => new CuppetControlClient(address.socket, 'wrong').call('status'), /unauthorized/)
  } finally {
    await server.close()
    await rm(runtime, { recursive: true, force: true })
  }
})
