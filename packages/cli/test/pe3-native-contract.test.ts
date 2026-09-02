import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'

const patchedRoot = process.env.CUPPET_PE3_PATCHED_SOURCE
const derivativeAvailable = Boolean(patchedRoot)

test('applied derivative sends bounded attachment metadata without payload bytes', { skip: !derivativeAvailable }, async () => {
  const route = await loadAppliedRouteModule()
  await withControlServer(async ({ requests }) => {
    const parts = [
      { type: 'text', text: 'implement src/dashboard/view.ts' },
      { type: 'file', filename: 'dashboard.png', mime: 'image/png', url: 'data:image/png;base64,AAAA' },
    ]
    const result = await route.routeCuppetNativePrompt({ sessionID: 'source', agent: 'build', parts })

    assert.equal(result?.targetSessionID, 'target')
    assert.equal(requests.length, 1)
    const request = requests[0] as Record<string, unknown>
    assert.equal(request.method, 'pe3.route-native')
    const params = request.params as Record<string, unknown>
    assert.equal(params.prompt, 'implement src/dashboard/view.ts')
    assert.deepEqual(params.attachments, [{ type: 'file', filename: 'dashboard.png', mime: 'image/png' }])
    assert.doesNotMatch(JSON.stringify(params), /data:image|base64|AAAA/)
  })
})

test('applied derivative fails closed for unsupported and attachment-only prompt parts', { skip: !derivativeAvailable }, async () => {
  const route = await loadAppliedRouteModule()
  await withControlServer(async ({ requests }) => {
    const unsupported = await route.routeCuppetNativePrompt({
      sessionID: 'source',
      agent: 'build',
      parts: [{ type: 'agent', name: 'subtask' }],
    })
    const attachmentOnly = await route.routeCuppetNativePrompt({
      sessionID: 'source',
      agent: 'build',
      parts: [{ type: 'file', filename: 'dashboard.png', mime: 'image/png' }],
    })

    assert.equal(unsupported, undefined)
    assert.equal(attachmentOnly, undefined)
    assert.equal(requests.length, 0)
  })
})

test('applied derivative recursive-forward guard consumes exactly one target routing attempt', { skip: !derivativeAvailable }, async () => {
  const route = await loadAppliedRouteModule()
  await withControlServer(async ({ requests }) => {
    const parts = [{ type: 'text', text: 'continue target work' }]
    route.markCuppetNativeForward(parts)

    const guarded = await route.routeCuppetNativePrompt({ sessionID: 'target', agent: 'build', parts })
    assert.equal(guarded, undefined)
    assert.equal(requests.length, 0)

    const next = await route.routeCuppetNativePrompt({ sessionID: 'target', agent: 'build', parts })
    assert.equal(next?.targetSessionID, 'target')
    assert.equal(requests.length, 1)
  })
})

test('applied derivative control failure returns no route instead of consuming the source request', { skip: !derivativeAvailable }, async () => {
  const route = await loadAppliedRouteModule()
  const previousSocket = process.env.CUPPET_CONTROL_SOCKET
  const previousToken = process.env.CUPPET_CONTROL_TOKEN
  process.env.CUPPET_CONTROL_SOCKET = join(tmpdir(), `cuppet-missing-${process.pid}-${Date.now()}.sock`)
  process.env.CUPPET_CONTROL_TOKEN = 'test-token'
  try {
    const result = await route.routeCuppetNativePrompt({
      sessionID: 'source',
      agent: 'build',
      parts: [{ type: 'text', text: 'keep this request on source if routing is unavailable' }],
    })
    assert.equal(result, undefined)
  } finally {
    restoreEnv('CUPPET_CONTROL_SOCKET', previousSocket)
    restoreEnv('CUPPET_CONTROL_TOKEN', previousToken)
  }
})

type AppliedRouteModule = {
  routeCuppetNativePrompt(input: { sessionID: string; agent?: string; parts: unknown[] }): Promise<{
    targetSessionID: string
  } | undefined>
  markCuppetNativeForward(parts: unknown[]): void
}

async function loadAppliedRouteModule(): Promise<AppliedRouteModule> {
  assert.ok(patchedRoot)
  const path = resolve(patchedRoot, 'packages/opencode/src/cuppet/pe3-route.ts')
  return import(`${pathToFileURL(path).href}?contract=${Date.now()}`) as Promise<AppliedRouteModule>
}

async function withControlServer(run: (state: { requests: unknown[] }) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'cuppet-pe3-control-'))
  const socketPath = join(directory, 'control.sock')
  const requests: unknown[] = []
  const server = createServer((socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const request = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
      requests.push(request)
      socket.end(`${JSON.stringify({
        ok: true,
        result: {
          rerouted: false,
          action: 'continue',
          sourceSessionID: 'source',
          targetSessionID: 'target',
          reason: 'test route',
          sequence: 1,
          refreshPaths: [],
        },
      })}\n`)
    })
  })
  await listen(server, socketPath)

  const previousSocket = process.env.CUPPET_CONTROL_SOCKET
  const previousToken = process.env.CUPPET_CONTROL_TOKEN
  process.env.CUPPET_CONTROL_SOCKET = socketPath
  process.env.CUPPET_CONTROL_TOKEN = 'test-token'
  try {
    await run({ requests })
  } finally {
    restoreEnv('CUPPET_CONTROL_SOCKET', previousSocket)
    restoreEnv('CUPPET_CONTROL_TOKEN', previousToken)
    await close(server)
    await rm(directory, { recursive: true, force: true })
  }
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolvePromise()
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()))
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
