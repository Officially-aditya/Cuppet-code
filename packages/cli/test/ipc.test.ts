import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import test from 'node:test'
import {
  connectIpc,
  isPipeEndpoint,
  isTcpEndpoint,
  parseIpcEndpoint,
  pickLoopbackPort,
  pipeEndpoint,
} from '../src/runtime/ipc.js'

test('IPC endpoints parse loopback TCP separately from socket paths', () => {
  assert.deepEqual(parseIpcEndpoint('127.0.0.1:53210'), { kind: 'tcp', host: '127.0.0.1', port: 53210 })
  assert.deepEqual(parseIpcEndpoint('localhost:8080'), { kind: 'tcp', host: 'localhost', port: 8080 })
  assert.equal(isTcpEndpoint('127.0.0.1:1'), true)
  assert.equal(isTcpEndpoint('/tmp/cupet/control.sock'), false)
  assert.deepEqual(parseIpcEndpoint('/tmp/cupet/control.sock'), { kind: 'path', path: '/tmp/cupet/control.sock' })
  assert.deepEqual(parseIpcEndpoint('\\\\.\\pipe\\cuppet-test'), { kind: 'path', path: '\\\\.\\pipe\\cuppet-test' })
  assert.equal(isPipeEndpoint(pipeEndpoint('cuppet-test')), true)
  assert.equal(isPipeEndpoint('/tmp/cupet/control.sock'), false)
  // Out-of-range ports and non-loopback hosts stay plain paths.
  assert.equal(isTcpEndpoint('127.0.0.1:0'), false)
  assert.equal(isTcpEndpoint('127.0.0.1:99999'), false)
  assert.equal(isTcpEndpoint('10.0.0.1:1234'), false)
})

test('IPC loopback TCP round-trips through connectIpc', async () => {
  const server = createServer((socket) => {
    socket.on('data', (chunk) => socket.write(`echo:${chunk.toString()}`))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const endpoint = `127.0.0.1:${address.port}`
  try {
    const client = await connectIpc(endpoint)
    const reply = await new Promise<string>((resolve, reject) => {
      client.once('data', (chunk) => resolve(chunk.toString()))
      client.once('error', reject)
      client.write('hello')
    })
    assert.equal(reply, 'echo:hello')
    client.destroy()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('pickLoopbackPort allocates a connectable port', async () => {
  const port = await pickLoopbackPort()
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65_535)
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
