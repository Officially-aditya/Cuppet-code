import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { test } from 'node:test'
import { TstClient } from '../src/tst/client.js'

const binary = process.env.CUPPET_TEST_TST_BIN
const binaryPath = binary
  ? isAbsolute(binary)
    ? binary
    : resolve(import.meta.dirname, '../../..', binary)
  : undefined

test('native daemon authenticates, persists verified memory, compacts, and restarts', { skip: !binary }, async () => {
  const root = process.platform === 'darwin' ? '/private/tmp' : tmpdir()
  const directory = await mkdtemp(join(root, 'cuppet-tst-contract-'))
  const projectStore = join(directory, 'project-store')
  const globalStore = join(directory, 'global-store')
  try {
    const first = await launch(binaryPath!, join(directory, 'first.sock'), projectStore, globalStore)
    const memoryChanged = new Promise<string>((resolvePromise, reject) => {
      const timeout = setTimeout(() => reject(new Error('memory.changed notification timed out')), 2_000)
      const unsubscribe = first.client.onNotification((notification) => {
        if (notification.method !== 'memory.changed') return
        clearTimeout(timeout)
        unsubscribe()
        resolvePromise(notification.method)
      })
    })
    const remembered = await first.client.call<{ id: string }>('memory.remember', {
      session_id: 'session-1',
      key: 'formatting preference',
      value: 'Use strict formatting',
      kind: 'preference',
      scope: 'project',
    })
    assert.match(remembered.id, /^m:/)
    assert.equal(await memoryChanged, 'memory.changed')
    const query = await first.client.call<{ ltm: Array<{ key: string }> }>('memory.query', {
      session_id: 'session-1',
      query: 'formatting preference',
      limit: 10,
    })
    assert.equal(query.ltm[0]?.key, 'formatting preference')
    await waitForGraph(first.client)
    const located = await first.client.call<{
      matches: Array<{ path: string; symbol: string; kind: string; line: number; column: number; content_hash?: string }>
    }>('graph.locate', {
      pattern: 'buildCuppetContext',
      limit: 99,
    })
    assert.ok(located.matches.length <= 12)
    assert.ok(located.matches.every((match) => match.path && match.kind && match.line > 0 && match.column > 0))
    assert.ok(located.matches.every((match) => match.content_hash === undefined))
    const trace = await first.client.call<{
      edges: Array<{ from: { path: string }; to: { path: string }; kind: string; span?: unknown }>
    }>('graph.trace_summary', {
      query: 'buildCuppetContext',
      direction: 'both',
      depth: 2,
      limit: 99,
    })
    assert.ok(trace.edges.length <= 12)
    assert.ok(trace.edges.every((edge) => edge.from.path && edge.to.path && edge.span === undefined))
    await first.client.call('compact')
    assert.equal((await stat(join(directory, 'first.sock'))).mode & 0o777, 0o600)
    await stop(first)

    const second = await launch(binaryPath!, join(directory, 'second.sock'), projectStore, globalStore)
    const restored = await second.client.call<{ ltm: Array<{ key: string }> }>('memory.query', {
      session_id: 'session-2',
      query: 'formatting preference',
      limit: 10,
    })
    assert.equal(restored.ltm[0]?.key, 'formatting preference')
    await stop(second)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

async function launch(binaryPath: string, socket: string, projectStore: string, globalStore: string) {
  const token = randomBytes(32).toString('hex')
  const child = spawn(
    binaryPath,
    [
      '--socket', socket,
      '--project-root', process.cwd(),
      '--project-store', projectStore,
      '--global-store', globalStore,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, CUPPET_TST_TOKEN: token } },
  )
  let errorText = ''
  child.stderr?.on('data', (chunk: Buffer) => (errorText += chunk.toString('utf8')))
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`daemon exited ${child.exitCode}: ${errorText}`)
    try {
      return { child, client: await TstClient.connect(socket, token) }
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    }
  }
  child.kill('SIGTERM')
  throw new Error(`daemon startup timed out: ${errorText}`)
}

async function stop(runtime: { child: ChildProcess; client: TstClient }) {
  await runtime.client.call('shutdown')
  runtime.client.destroy()
  await new Promise<void>((resolvePromise) => {
    if (runtime.child.exitCode !== null) return resolvePromise()
    runtime.child.once('exit', () => resolvePromise())
  })
}

async function waitForGraph(client: TstClient): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const status = await client.call<{ graph?: { progress?: { complete?: boolean } } }>('status')
    if (status.graph?.progress?.complete) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25))
  }
  throw new Error('graph indexing timed out')
}
