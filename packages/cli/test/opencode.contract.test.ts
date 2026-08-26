import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { createRuntimePaths } from '../src/runtime/paths.js'
import { RedactedLogger } from '../src/runtime/logger.js'
import { OpenCodeGateway } from '../src/opencode/gateway.js'
import { startOpenCodeServer, type OpenCodeRuntime } from '../src/opencode/server.js'
import { startTstDaemon, type TstRuntime } from '../src/tst/supervisor.js'
import type { AgentEvent } from '../src/types.js'

const binary = process.env.CUPPET_CONTRACT_OPENCODE_BIN
const execFile = promisify(execFileCallback)

test('pinned OpenCode binary exposes the v2 catalog and stable cross-provider execution contract', { skip: !binary }, async () => {
  const root = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
  const project = await mkdtemp(join(root, 'cuppet-opencode-contract-'))
  await writeFile(join(project, 'input.txt'), 'read contract fixture\n', 'utf8')
  const fakeModel = await startFakeModelServer(project)
  await writeFile(join(project, 'opencode.json'), JSON.stringify({
    provider: {
      'cuppet-contract': {
        name: 'Cuppet Contract Provider',
        npm: '@ai-sdk/openai-compatible',
        api: `${fakeModel.url}/v1`,
        env: [],
        models: {
          'contract-model': {
            name: 'Contract Model',
            tool_call: true,
            limit: { context: 100_000, output: 4_096 },
            cost: { input: 0, output: 0 },
          },
        },
        options: { apiKey: 'local-contract-key', baseURL: `${fakeModel.url}/v1` },
      },
    },
  }), 'utf8')
  const paths = await createRuntimePaths(project, join(project, '.cuppet-test'))
  const logger = new RedactedLogger(paths.logs)
  let tst: TstRuntime | undefined
  if (process.env.CUPPET_TEST_TST_BIN) {
    tst = await startTstDaemon(resolve(process.env.CUPPET_TEST_TST_BIN), paths, logger)
  }
  let runtime: OpenCodeRuntime | undefined
  let gateway: OpenCodeGateway | undefined
  try {
    runtime = await startOpenCodeServer({
      binary: binary!,
      paths,
      logger,
      plugin: resolve(import.meta.dirname, '../../opencode-plugin/dist/index.js'),
      secondaryModel: { providerID: 'cuppet-contract', modelID: 'contract-model' },
      graphNativeProfile: true,
      ...(tst ? { tst: { socket: tst.socket, token: tst.token } } : {}),
    })
    const health = await runtime.client.v2.health.get({ throwOnError: true })
    assert.ok(health.data)
    const agents = await runtime.client.v2.agent.list({ location: { directory: paths.projectRealpath } })
    const cuppet = (agents.data?.data ?? []).find((agent) => agent.id === 'cuppet')
    assert.ok(cuppet, 'the configured Cuppet agent should be visible to the v2 session engine')
    assert.ok(cuppet.permissions.some((rule) => rule.action === 'read' && rule.resource === '*' && rule.effect === 'allow'))
    assert.ok(cuppet.permissions.some((rule) => rule.action === 'read' && rule.resource === '**/.env' && rule.effect === 'ask'))
    assert.ok(cuppet.permissions.some((rule) => rule.action === 'read' && rule.resource === '**/.claude.json' && rule.effect === 'deny'))
    assert.ok(cuppet.permissions.some((rule) => rule.action === 'edit' && rule.resource === '*' && rule.effect === 'ask'))
    assert.ok(cuppet.permissions.some((rule) => rule.action === 'bash' && rule.resource === '*' && rule.effect === 'ask'))
    assert.equal(cuppet.permissions.some((rule) => rule.action === 'read_file'), false)
    const legacyAgents = await runtime.client.app.agents({ directory: paths.projectRealpath })
    const legacyCuppet = legacyAgents.data?.find((agent) => agent.name === 'cuppet')
    assert.ok(legacyCuppet, 'the Cuppet agent should also be visible to the stable provider/session engine')
    assert.ok(legacyCuppet.permission.some((rule) => rule.permission === 'read' && rule.pattern === '*' && rule.action === 'allow'))
    assert.ok(legacyCuppet.permission.some((rule) => rule.permission === 'edit' && rule.pattern === '*' && rule.action === 'ask'))
    assert.ok(legacyCuppet.permission.some((rule) => rule.permission === 'bash' && rule.pattern === '*' && rule.action === 'ask'))
    const expectedSubagentModel = {
      providerID: 'cuppet-contract',
      modelID: 'contract-model',
    }
    for (const name of ['general', 'explore', 'cuppet-background']) {
      const agent = legacyAgents.data?.find((candidate) => candidate.name === name)
      assert.deepEqual(agent?.model, expectedSubagentModel, `${name} must use the configured secondary model`)
    }
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
    const legacy = await runtime.client.provider.list({ directory: paths.projectRealpath })
    const providerByID = new Map((legacy.data?.all ?? []).map((provider) => [provider.id, provider]))
    const configurable = catalog.find((item) => {
      if (item.providerID === 'cuppet-contract') return false
      const variants = providerByID.get(item.providerID)?.models[item.id]?.variants
      return variants && Object.keys(variants).length > 0
    })
    assert.ok(configurable, 'the legacy catalog should advertise at least one configurable model')
    gateway = new OpenCodeGateway(runtime.client, paths.projectRealpath)
    const integrations = await gateway.listIntegrations()
    const openAI = integrations.find((integration) => integration.id === 'openai')
    const browserOAuth = openAI?.methods.find(
      (method) => method.type === 'oauth' && /browser/i.test(method.label),
    )
    assert.ok(browserOAuth?.id?.startsWith('legacy:'), 'browser OAuth must persist into the execution provider store')
    const oauth = await gateway.beginOAuth('openai', browserOAuth!.id!)
    assert.equal(new URL(oauth.url).origin, 'https://auth.openai.com')
    await gateway.cancelOAuth(oauth.attemptID)

    const vertexDebug = resolve(paths.runtime, 'vertex-debug')
    const vertexXdg = {
      config: resolve(vertexDebug, 'config'),
      data: resolve(vertexDebug, 'data'),
      cache: resolve(vertexDebug, 'cache'),
      state: resolve(vertexDebug, 'state'),
    }
    await Promise.all(Object.values(vertexXdg).map((directory) => mkdir(directory, { recursive: true })))
    const dummyAdc = resolve(vertexDebug, 'adc.json')
    await writeFile(dummyAdc, '{}', 'utf8')
    const debug = await execFile(binary!, ['debug', 'v2'], {
      cwd: resolve(import.meta.dirname, '../../..'),
      env: {
        ...process.env,
        XDG_CONFIG_HOME: vertexXdg.config,
        XDG_DATA_HOME: vertexXdg.data,
        XDG_CACHE_HOME: vertexXdg.cache,
        XDG_STATE_HOME: vertexXdg.state,
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
        GOOGLE_APPLICATION_CREDENTIALS: dummyAdc,
        GOOGLE_CLOUD_PROJECT: 'cuppet-contract-project',
      },
      maxBuffer: 10 * 1024 * 1024,
    })
    const debugJson = JSON.parse(debug.stdout.slice(debug.stdout.indexOf('{'))) as {
      providers: Array<{ id: string; api: { package?: string } }>
    }
    const vertexProvider = debugJson.providers.find((provider) => provider.id === 'google-vertex')
    assert.equal(vertexProvider?.api.package, '@ai-sdk/google-vertex')
    assert.equal(debugJson.providers.some((provider) => provider.id === 'vertex'), false)

    const gatewayModels = await gateway.listModels()
    assert.ok(gatewayModels.length > 0, 'at least one connected, executable OpenCode model should be selectable')
    const selected = gatewayModels[0]!
    const created = await gateway.createSession(selected)
    const sessionID = created.id
    assert.equal((await runtime.client.session.get({ sessionID, directory: paths.projectRealpath })).response.status, 200)
    await assert.doesNotReject(gateway.switchModel(sessionID, selected))
    assertSuccessful(
      (await runtime.client.session.prompt({
        sessionID,
        directory: paths.projectRealpath,
        model: { providerID: selected.providerID, modelID: selected.modelID },
        ...(selected.variant ? { variant: selected.variant } : {}),
        agent: 'cuppet',
        noReply: true,
        parts: [{ type: 'text', text: 'offline contract message' }],
      })).response.status,
    )
    assert.equal((await runtime.client.session.messages({ sessionID, directory: paths.projectRealpath })).response.status, 200)
    assert.equal((await runtime.client.permission.list({ directory: paths.projectRealpath })).response.status, 200)
    await assert.doesNotReject(gateway.interrupt(sessionID))

    const contractModel = gatewayModels.find(
      (candidate) => candidate.providerID === 'cuppet-contract' && candidate.modelID === 'contract-model',
    )
    assert.ok(contractModel, 'custom OpenAI-compatible providers must remain executable through the stable engine')
    const toolSession = await gateway.createSession(contractModel, false, false, false, true)
    const observed: AgentEvent[] = []
    let permissionFailure: Error | undefined
    const unsubscribe = gateway.onEvent((event) => {
      observed.push(event)
      if (event.type === 'permission' && event.request.sessionID === toolSession.id) {
        void gateway!.replyPermission(toolSession.id, event.request.id, 'once').catch((error) => {
          permissionFailure = error as Error
        })
      }
    })
    gateway.startEvents()
    await delay(250)
    await gateway.prompt(toolSession.id, 'Read input.txt, then write output.txt with the verified content.')
    try {
      await withTimeout(gateway.wait(toolSession.id), 20_000, 'tool loop did not become idle')
    } catch (error) {
      const pending = await runtime.client.permission.list({ directory: paths.projectRealpath })
      throw new Error(
        `${(error as Error).message}; observed=${JSON.stringify(observed)}; ` +
        `pending=${JSON.stringify(pending.data)}; requests=${JSON.stringify(fakeModel.requests)}`,
      )
    }
    await delay(100)
    unsubscribe()
    assert.ifError(permissionFailure)
    assert.equal(await readFile(join(project, 'output.txt'), 'utf8'), 'write contract passed\n')
    assert.deepEqual(
      observed
        .filter((event): event is Extract<AgentEvent, { type: 'permission' }> => event.type === 'permission')
        .map((event) => event.request.action),
      ['edit'],
      'project reads should be allowed while writes require an explicit permission',
    )
    const tools = observed
      .filter((event): event is Extract<AgentEvent, { type: 'tool-start' }> => event.type === 'tool-start')
      .map((event) => event.name)
    assert.ok(tools.includes('read'))
    assert.ok(tools.includes('write'))
    const toolPayload = [...fakeModel.requests]
      .reverse()
      .find((request) => Array.isArray(request.tools) && (request.tools as string[]).includes('cuppet_graph_search'))
    assert.ok(toolPayload, 'the fake provider should receive the graph-native tool payload')
    const exposedTools = toolPayload.tools as string[]
    for (const legacyTool of ['glob', 'grep', 'lsp', 'webfetch', 'websearch', 'task']) {
      assert.equal(exposedTools.includes(legacyTool), false, `${legacyTool} must be hidden from graph-native agents`)
    }
    for (const graphTool of ['cuppet_workspace_info', 'cuppet_graph_tree', 'cuppet_graph_search', 'cuppet_graph_trace']) {
      assert.equal(exposedTools.includes(graphTool), true, `${graphTool} must be exposed to graph-native agents`)
    }
    assert.deepEqual(
      new Set(configurable.variants.map((variant) => variant.id)),
      new Set(Object.keys(providerByID.get(configurable.providerID)?.models[configurable.id]?.variants ?? {})),
      'the v2 catalog should preserve every provider-advertised model variant',
    )
    assert.match(
      observed
        .filter((event): event is Extract<AgentEvent, { type: 'text-delta' }> => event.type === 'text-delta')
        .map((event) => event.text)
        .join(''),
      /contract complete/i,
    )
    const sessionErrors = observed.filter(
      (event): event is Extract<AgentEvent, { type: 'error' }> =>
        event.type === 'error' && (!event.sessionID || event.sessionID === toolSession.id),
    )
    assert.deepEqual(sessionErrors, [])
    if (tst) {
      const toolIDs = await runtime.client.tool.ids({ directory: paths.projectRealpath })
      assert.ok(toolIDs.data?.includes('cuppet_plan'))
      assert.ok(toolIDs.data?.includes('cuppet_memory_search'))
      assert.ok(toolIDs.data?.includes('cuppet_workspace_info'))
      assert.ok(toolIDs.data?.includes('cuppet_graph_tree'))
      assert.ok(toolIDs.data?.includes('cuppet_graph_search'))
      assert.ok(toolIDs.data?.includes('cuppet_graph_trace'))
    }
  } finally {
    await gateway?.close()
    await runtime?.close()
    await tst?.close()
    await fakeModel.close()
    await rm(project, { recursive: true, force: true })
  }
})

function assertSuccessful(status: number): void {
  assert.ok(status >= 200 && status < 300, `expected a successful HTTP status, received ${status}`)
}

async function startFakeModelServer(project: string): Promise<{
  url: string
  requests: Array<Record<string, unknown>>
  close(): Promise<void>
}> {
  const requests: Array<Record<string, unknown>> = []
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        messages?: Array<{ role?: string }>
        tools?: unknown[]
      }
      const toolResults = body.messages?.filter((message) => message.role === 'tool').length ?? 0
      requests.push({
        path: request.url,
        toolResults,
        tools: Array.isArray(body.tools)
          ? body.tools.map((tool) => String((tool as { function?: { name?: unknown } }).function?.name ?? 'unknown'))
          : [],
        roles: body.messages?.map((message) => message.role),
      })
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      response.write(sseChunk({ role: 'assistant' }))
      if (!body.tools?.length) {
        response.write(sseChunk({ content: 'Contract title' }))
        response.write(sseFinish('stop'))
      } else if (toolResults === 0) {
        response.write(sseChunk({
          tool_calls: [{
            index: 0,
            id: 'call_read_contract',
            type: 'function',
            function: { name: 'read', arguments: JSON.stringify({ filePath: 'input.txt' }) },
          }],
        }))
        response.write(sseFinish('tool_calls'))
      } else if (toolResults === 1) {
        response.write(sseChunk({
          tool_calls: [{
            index: 0,
            id: 'call_write_contract',
            type: 'function',
            function: {
              name: 'write',
              arguments: JSON.stringify({
                filePath: join(project, 'output.txt'),
                content: 'write contract passed\n',
              }),
            },
          }],
        }))
        response.write(sseFinish('tool_calls'))
      } else {
        response.write(sseChunk({ content: 'Contract complete.' }))
        response.write(sseFinish('stop'))
      }
      response.end('data: [DONE]\n\n')
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: (error as Error).message }))
    }
  })
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolvePromise())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fake model server did not bind a TCP port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  }
}

function sseChunk(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-cuppet-contract',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1_000),
    model: 'contract-model',
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`
}

function sseFinish(reason: 'stop' | 'tool_calls'): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-cuppet-contract',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1_000),
    model: 'contract-model',
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  })}\n\n`
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise())
    server.closeAllConnections()
  })
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}
