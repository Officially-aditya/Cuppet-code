import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { CuppetControlClient } from '../src/control/client.js'
import { CuppetControlServer, createControlAddress } from '../src/control/server.js'
import { readOrchestratorState, writeOrchestratorState } from '../src/control/orchestrator-state.js'

test('orchestrator control RPC toggles state and persists it for the plugin', async (t) => {
  const runtime = await mkdtemp(join(process.cwd(), '.orchestrator-test-'))
  const paths = { runtime } as never
  let enabled = false
  const controller = {
    get orchestratorEnabled() {
      return enabled
    },
    async setOrchestratorEnabled(value: boolean) {
      enabled = value
      await writeOrchestratorState(paths, value)
    },
    get snapshot() {
      return { orchestrator: { enabled } }
    },
    async status() {
      return { product: 'Cuppet' }
    },
    async doctor() {
      return { healthy: true }
    },
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
    assert.deepEqual(await client.call('orchestrator.status'), { enabled: false })
    await client.call('orchestrator.set', { enabled: true })
    assert.deepEqual(await client.call('orchestrator.status'), { enabled: true })
    // The plugin (separate process) observes the same flag through this file.
    assert.equal(readOrchestratorState(paths), true)
    await client.call('orchestrator.set', {})
    assert.fail('missing enabled must be rejected')
  } catch (error) {
    assert.match((error as Error).message, /requires enabled/)
  } finally {
    await server.close().catch(() => undefined)
    await rm(runtime, { recursive: true, force: true })
  }
})
