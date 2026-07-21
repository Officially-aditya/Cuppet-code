import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { createRuntimePaths } from '../src/runtime/paths.js'
import { RedactedLogger } from '../src/runtime/logger.js'
import { OpenCodeGateway } from '../src/opencode/gateway.js'
import { startOpenCodeServer, type OpenCodeRuntime } from '../src/opencode/server.js'
import { startTstDaemon, type TstRuntime } from '../src/tst/supervisor.js'

const binary = process.env.CUPPET_CONTRACT_OPENCODE_BIN

test('pinned OpenCode binary exposes the expected v2 health and catalog contract', { skip: !binary }, async () => {
  const paths = await createRuntimePaths(process.cwd())
  const logger = new RedactedLogger(paths.logs)
  let tst: TstRuntime | undefined
  if (process.env.CUPPET_TEST_TST_BIN) {
    tst = await startTstDaemon(resolve(process.env.CUPPET_TEST_TST_BIN), paths, logger)
  }
  let runtime: OpenCodeRuntime | undefined
  try {
    runtime = await startOpenCodeServer({
      binary: binary!,
      paths,
      logger,
      ...(tst
        ? {
            plugin: resolve(import.meta.dirname, '../../opencode-plugin/dist/index.js'),
            tst: { socket: tst.socket, token: tst.token },
          }
        : {}),
    })
    const health = await runtime.client.v2.health.get({ throwOnError: true })
    assert.ok(health.data)
    const models = await runtime.client.v2.model.list({ location: { directory: paths.projectRealpath } })
    assert.equal(models.response.status, 200)
    const catalog = (models.data as {
      data?: Array<{
        id: string
        providerID: string
        enabled: boolean
        status: string
        variants: Array<{ id: string }>
      }>
    } | undefined)?.data ?? []
    const model = catalog.find((item) => item.enabled && item.status !== 'deprecated')
    assert.ok(model, 'the live OpenCode catalog should expose at least one enabled model')
    const integrations = await runtime.client.v2.integration.list({ location: { directory: paths.projectRealpath } })
    assert.equal(integrations.response.status, 200)
    const gateway = new OpenCodeGateway(runtime.client, paths.projectRealpath)
    const gatewayModels = await gateway.listModels()
    const expectedSelections = catalog
      .filter((item) => item.enabled && item.status !== 'deprecated')
      .reduce((count, item) => count + 1 + item.variants.length, 0)
    assert.equal(gatewayModels.length, expectedSelections, 'every advertised model variant should be selectable')
    const created = await runtime.client.v2.session.create({
      agent: 'cuppet',
      model: { id: model.id, providerID: model.providerID },
      location: { directory: paths.projectRealpath },
    })
    assert.equal(created.response.status, 200)
    const sessionID = (created.data as { data?: { id?: string } } | undefined)?.data?.id
    assert.ok(sessionID)
    assert.equal((await runtime.client.v2.session.get({ sessionID })).response.status, 200)
    await assert.doesNotReject(gateway.switchModel(sessionID, { modelID: model.id, providerID: model.providerID }))
    assertSuccessful(
      (await runtime.client.v2.session.prompt({
        sessionID,
        prompt: { text: 'offline contract message' },
        delivery: 'queue',
        resume: false,
      })).response.status,
    )
    assert.equal((await runtime.client.v2.session.messages({ sessionID })).response.status, 200)
    assert.equal((await runtime.client.v2.session.permission.list({ sessionID })).response.status, 200)
    await assert.doesNotReject(gateway.interrupt(sessionID))
    if (tst) {
      const tools = await runtime.client.tool.ids({ directory: paths.projectRealpath })
      assert.ok(tools.data?.includes('cuppet_memory_search'))
    }
  } finally {
    await runtime?.close()
    await tst?.close()
    await rm(paths.runtime, { recursive: true, force: true })
  }
})

function assertSuccessful(status: number): void {
  assert.ok(status >= 200 && status < 300, `expected a successful HTTP status, received ${status}`)
}
