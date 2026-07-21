import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { TstToolClient } from '../src/rpc.js'

test('read-only tool client authenticates and uses length-framed JSON-RPC', async () => {
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
        const result = request.method === 'memory.query' ? { stm: [], ltm: [{ key: 'style' }], graph: [] } : { protocol: 'cuppet.tst.v1' }
        const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }))
        const header = Buffer.alloc(4)
        header.writeUInt32BE(payload.length)
        socket.write(Buffer.concat([header, payload]))
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  try {
    const result = await new TstToolClient(socketPath, 'a'.repeat(64)).query('session', 'style', 20)
    assert.deepEqual(methods, ['initialize', 'memory.query'])
    assert.deepEqual(result, { stm: [], ltm: [{ key: 'style' }], graph: [] })
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
})
