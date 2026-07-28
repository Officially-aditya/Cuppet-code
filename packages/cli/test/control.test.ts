import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { CuppetControlClient } from '../src/control/client.js'
import { CuppetControlServer, createControlAddress } from '../src/control/server.js'

test('launch-scoped control API authenticates and exposes diagnostics', async (t) => {
  const runtime = await mkdtemp(join(process.cwd(), '.control-test-'))
  const paths = { runtime } as never
  let selectedPlatform = 'openai'
  let nativeAgent = 'build'
  const controller = {
    async status() { return { product: 'Cuppet' } },
    async doctor() { return { healthy: true } },
    get snapshot() { return { background: { paused: false }, platform: selectedPlatform, planMode: nativeAgent === 'plan' } },
    syncNativeAgent(agent: string) { nativeAgent = agent; return nativeAgent === 'plan' },
    modelsForPlatform(platform: string) { return platform === 'vertex' ? [{ id: 'gemini' }] : [] },
    integrationsForPlatform(platform: string) {
      return platform === 'vertex' ? [{ id: 'google-vertex', connections: [{ type: 'provider' }] }] : []
    },
    async selectPlatform(platform: string) { selectedPlatform = platform },
  } as never
  const address = createControlAddress(paths)
  let server: CuppetControlServer
  try {
    server = await CuppetControlServer.start(controller, paths, address)
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
    const platforms = await client.call<{ selected: string; options: Array<{ value: string; connected: boolean }> }>('platform.list')
    assert.equal(platforms.selected, 'openai')
    assert.equal(platforms.options.find((option) => option.value === 'vertex')?.connected, true)
    assert.equal((await client.call<{ selected: string }>('platform.select', { platform: 'vertex' })).selected, 'vertex')
    assert.deepEqual(await client.call('plan.set', { agent: 'plan' }), { enabled: true, agent: 'plan' })
    assert.deepEqual(await client.call('plan.toggle'), { enabled: false, agent: 'build' })
    assert.equal((await stat(address.socket)).mode & 0o777, 0o600)
    await assert.rejects(() => new CuppetControlClient(address.socket, 'wrong').call('status'), /unauthorized/)
  } finally {
    await server.close()
    await rm(runtime, { recursive: true, force: true })
  }
})
