import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CuppetMemoryPlugin } from '../src/index.js'
import { TstToolClient } from '../src/rpc.js'

test('read-only tool client authenticates and uses length-framed JSON-RPC', async (t) => {
  const temporaryRoot = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
  const directory = await mkdtemp(join(temporaryRoot, 'cuppet-plugin-rpc-'))
  const socketPath = join(directory, 'tst.sock')
  const methods: string[] = []
  const server = createServer((socket) => {
    let buffered = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0)
        if (buffered.length < length + 4) return
        const request = JSON.parse(buffered.subarray(4, length + 4).toString('utf8')) as {
          id: number
          method: string
          params: Record<string, unknown>
        }
        buffered = buffered.subarray(length + 4)
        methods.push(request.method)
        if (request.method === 'initialize') assert.equal(request.params.token, 'a'.repeat(64))
        const result = request.method === 'memory.query'
          ? { stm: [], ltm: [{ key: 'style' }], graph: [] }
          : request.method === 'graph.locate'
            ? {
                query: 'dueDate',
                matches: [{ path: 'src/task.ts', symbol: 'dueDate', kind: 'property', line: 3, column: 1 }],
                truncated: false,
              }
            : request.method === 'graph.trace_summary'
              ? { query: 'dueDate', direction: 'both', depth: 2, edges: [], truncated: false }
              : request.method.startsWith('graph.')
                ? { query: 'dueDate', nodes: [], text_matches: [], paths: [], root: '/tmp/project' }
                : { protocol: 'cuppet.tst.v2' }
        const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
        const header = Buffer.alloc(4)
        header.writeUInt32BE(payload.length)
        socket.write(Buffer.concat([header, payload]))
      }
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
  } catch (error) {
    server.close()
    await rm(directory, { recursive: true, force: true })
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('sandbox does not permit Unix-domain sockets')
      return
    }
    throw error
  }
  try {
    const result = await new TstToolClient(socketPath, 'a'.repeat(64)).query('session', 'style', 20)
    assert.deepEqual(result, { stm: [], ltm: [{ key: 'style' }], graph: [] })
    const client = new TstToolClient(socketPath, 'a'.repeat(64))
    await client.graphSearch('dueDate', 'games/task-tracker', 10)
    await client.graphLocate('dueDate', 'games/task-tracker', 10)
    await client.graphList('games/task-tracker', 10)
    await client.graphWorkspace(10)
    await client.graphTrace('createTask', 'callees', 2, 10)
    await client.graphTraceSummary('createTask', 'callees', 2, 10)
    const oldSocket = process.env.CUPPET_TST_SOCKET
    const oldToken = process.env.CUPPET_TST_TOKEN
    process.env.CUPPET_TST_SOCKET = socketPath
    process.env.CUPPET_TST_TOKEN = 'a'.repeat(64)
    try {
      const plugin = await CuppetMemoryPlugin()
      const tool = plugin.tool.cuppet_graph_search
      const first = await tool.execute({ pattern: 'dueDate' }, { sessionID: 'dedupe-session' })
      const second = await tool.execute({ pattern: 'dueDate', limit: 12 }, { sessionID: 'dedupe-session' })
      assert.notEqual(typeof first, 'string')
      assert.notEqual(typeof second, 'string')
      if (typeof first === 'string' || typeof second === 'string') throw new Error('graph tool unexpectedly degraded')
      assert.match(first.output, /src\/task\.ts:3:1/)
      assert.match(second.output, /already returned earlier in this session/)
      assert.equal(second.metadata.cacheHit, true)
    } finally {
      if (oldSocket === undefined) delete process.env.CUPPET_TST_SOCKET
      else process.env.CUPPET_TST_SOCKET = oldSocket
      if (oldToken === undefined) delete process.env.CUPPET_TST_TOKEN
      else process.env.CUPPET_TST_TOKEN = oldToken
    }
    assert.deepEqual(methods, [
      'initialize',
      'memory.query',
      'initialize',
      'graph.search',
      'initialize',
      'graph.locate',
      'initialize',
      'graph.list',
      'initialize',
      'graph.workspace',
      'initialize',
      'graph.trace',
      'initialize',
      'graph.trace_summary',
      'initialize',
      'graph.locate',
    ])
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
