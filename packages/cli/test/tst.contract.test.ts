import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { test } from 'node:test'
import { TstClient } from '../src/tst/client.js'

const binary = process.env.CUPPET_TEST_TST_BIN
const binaryPath = binary
  ? resolveBinary(isAbsolute(binary) ? binary : resolve(import.meta.dirname, '../../..', binary))
  : undefined

function resolveBinary(value: string): string {
  // CI passes the extensionless cargo output path; Windows binaries carry
  // the `.exe` suffix, so fall back to it when the exact path is missing.
  if (process.platform !== 'win32' || value.toLowerCase().endsWith('.exe')) return value
  if (existsSync(value)) return value
  return `${value}.exe`
}

test('native daemon retains ranked session history, persists verified memory, compacts, and restarts', { skip: !binary }, async () => {
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
    await first.client.call('memory.observe', {
      session_id: 'session-1',
      key: 'pinned constraint',
      value: 'Never remove the public API boundary',
      kind: 'concept_anchor',
      scope: 'session',
      provenance: 'explicit_user',
      pinned: true,
    })
    const refreshed = await first.client.call<{
      records: Array<{ key?: string }>
      paths: string[]
      eviction: { retained: number }
    }>('stm.refresh', {
      session_id: 'session-1',
      query: 'packages/cli/src/tst/context.ts',
      prompt: 'Keep packages/cli/src/tst/context.ts bounded',
      requirements: [{
        key: 'file requirement',
        value: 'Preserve packages/cli/src/tst/context.ts',
        paths: ['packages/cli/src/tst/context.ts'],
        explicit: true,
      }],
      explicit_paths: ['packages/cli/src/tst/context.ts'],
      file_evidence: [{ path: 'packages/cli/src/tst/context.ts', explicit: true }],
    })
    assert.ok(refreshed.records.length > 0)
    assert.ok(refreshed.paths.includes('packages/cli/src/tst/context.ts'))
    assert.ok(refreshed.eviction.retained > 0)

    const retainedHistory = await first.client.call<{
      records: Array<{ key?: string; value?: string; pinned?: boolean }>
      paths: string[]
      eviction: {
        retained: number
        evicted_file_anchors: number
        evicted_constraints: number
        pinned_preserved: number
      }
    }>('stm.refresh', {
      session_id: 'session-1',
      query: 'Task.name src/important.ts src/validated.ts',
      prompt: 'Rename Task.title to Task.name; preserve the public API and do not modify src/unrelated.ts.',
      requirements: [{
        key: 'rename requirement',
        value: 'Rename Task.title to Task.name in src/important.ts',
        paths: ['src/important.ts'],
        explicit: true,
      }],
      outcomes: [{
        key: 'validation outcome',
        value: 'Validation passed for src/validated.ts',
        paths: ['src/validated.ts'],
        validated: true,
      }],
      constraints: Array.from({ length: 20 }, (_, index) => ({
        key: `constraint-${index}`,
        value: `Preserve constraint ${index} and the public API`,
      })),
      candidates: Array.from({ length: 40 }, (_, index) => ({
        key: `noise-anchor-${index}`,
        value: `Unrelated candidate src/noise-${index}.ts`,
        paths: [`src/noise-${index}.ts`],
      })),
      explicit_paths: ['src/important.ts'],
      tool_paths: ['src/touched.ts'],
      validated_paths: ['src/validated.ts'],
      file_evidence: [
        { path: 'src/important.ts', explicit: true },
        { path: 'src/touched.ts', tool_touched: true },
        { path: 'src/validated.ts', validated: true },
      ],
    })
    const historyText = retainedHistory.records
      .map((record) => `${record.key ?? ''} ${record.value ?? ''}`)
      .join('\n')
    assert.match(historyText, /Rename Task\.title to Task\.name/)
    assert.match(historyText, /Validation passed for src\/validated\.ts/)
    assert.ok(retainedHistory.paths.includes('src/important.ts'))
    assert.ok(retainedHistory.paths.includes('src/validated.ts'))
    assert.ok(retainedHistory.paths.includes('src/touched.ts'))
    assert.ok(retainedHistory.eviction.evicted_file_anchors > 0)
    assert.ok(retainedHistory.eviction.evicted_constraints > 0)
    assert.ok(retainedHistory.eviction.pinned_preserved >= 1)
    assert.ok(retainedHistory.eviction.retained <= 49)
    assert.ok(retainedHistory.records.some((record) => record.pinned && record.key === 'pinned constraint'))

    const stmOnly = await first.client.call<{
      ltm: unknown[]
      graph: unknown[]
      stm: Array<{ key?: string }>
    }>('context.prepare', {
      session_id: 'session-1',
      query: 'Task.name src/important.ts',
      mode: 'stm_only',
      observations: [],
    })
    assert.deepEqual(stmOnly.ltm, [])
    assert.deepEqual(stmOnly.graph, [])
    assert.ok(stmOnly.stm.some((record) => record.key === 'rename requirement'))
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
    // Windows daemons use loopback TCP, so there is no socket file whose
    // mode can be asserted; POSIX daemons must keep the socket private.
    if (process.platform !== 'win32') {
      assert.equal((await stat(join(directory, 'first.sock'))).mode & 0o777, 0o600)
    }
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
  // Windows has no Unix-domain sockets: run the contract daemon on loopback
  // TCP, mirroring the supervisor's Windows transport.
  const endpoint = process.platform === 'win32' ? `127.0.0.1:${await pickLoopbackPort()}` : socket
  const transportArguments = process.platform === 'win32'
    ? ['--host', '127.0.0.1', '--port', endpoint.split(':')[1]!]
    : ['--socket', socket]
  const child = spawn(
    binaryPath,
    [
      ...transportArguments,
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
      return { child, client: await TstClient.connect(endpoint, token) }
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    }
  }
  child.kill('SIGTERM')
  throw new Error(`daemon startup timed out: ${errorText}`)
}

async function pickLoopbackPort(host = '127.0.0.1'): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, host, () => resolve())
  })
  const address = probe.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  if (!port) throw new Error('unable to allocate a loopback TCP port')
  return port
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
