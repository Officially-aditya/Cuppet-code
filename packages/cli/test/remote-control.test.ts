import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { ControlRouter, type ControlActor } from '../src/control/router.js'
import { RemoteBridge } from '../src/remote/bridge.js'
import {
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  encodeFrame,
  parseCommandFrame,
  publicEventFor,
} from '../src/remote/protocol.js'
import {
  authenticateDevice,
  claimPairingInvite,
  createPairingInvite,
  revokeDevice,
} from '../src/remote/pairing.js'
import type { AgentEvent } from '../src/types.js'

const LOCAL: ControlActor = { kind: 'local' }

function remoteActor(scopes: string[]): ControlActor {
  return { kind: 'remote', deviceID: 'dev_test', scopes }
}

function stubController(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  let newSessions = 0
  return {
    async listSessions() { return [{ id: 'ses_1' }] },
    async newSession() { newSessions += 1; return { id: `ses_${newSessions}` } },
    async abort() { return undefined },
    async status() { return { sessions: 1 } },
    async listPendingPermissions() { return [] },
    async listPendingQuestions() { return [] },
    get snapshot() { return { models: [{ providerID: 'p', modelID: 'm' }], platform: 'anthropic', primary: { providerID: 'anthropic', modelID: 'claude' }, secondary: { providerID: 'p', modelID: 'm' }, planMode: false } },
    workspaceInfo() {
      return { workspaceId: 'w1', name: 'Cuppet', pathDisplay: '~/Projects/Cuppet', activeSessionId: 'ses_1' }
    },
    providerStatus() {
      return { configured: true, ready: true, selectedProvider: 'anthropic', selectedModel: 'anthropic/claude' }
    },
    syncNativeAgent(agent: string) { return agent === 'plan' },
    ...overrides,
  }
}

test('control router authorizes remote actors per scope and keeps local-only methods unreachable', async () => {
  const router = new ControlRouter(stubController() as never)
  assert.deepEqual(await router.execute(LOCAL, 'session.list'), [{ id: 'ses_1' }])
  assert.deepEqual(await router.execute(remoteActor(['session.read']), 'session.list'), [{ id: 'ses_1' }])
  await assert.rejects(
    () => router.execute(remoteActor(['session.read']), 'session.abort'),
    /missing scope 'session.write'/,
  )
  await assert.rejects(
    () => router.execute(remoteActor(['session.read', 'session.write']), 'doctor'),
    /not permitted for remote actors/,
  )
  await assert.rejects(() => router.execute(LOCAL, 'nonexistent.method'), /unknown control method/)
})

test('control router maps the remote coding surface onto the controller', async () => {
  let aborted = 0
  let capturedAnswers: string[][] | undefined
  const router = new ControlRouter(
    stubController({
      async abort() { aborted += 1 },
      async replyQuestion(_requestID: string, answers: string[][]) { capturedAnswers = answers },
    }) as never,
  )
  await router.execute(remoteActor(['session.write']), 'session.abort')
  assert.equal(aborted, 1)
  await assert.rejects(() => router.execute(remoteActor(['session.write']), 'plan.set', { agent: 'bogus' }), /plan or build/)

  // Question answers must survive as one array per question.
  await router.execute(
    remoteActor(['question.write']),
    'question.reply',
    { requestID: 'q1', answers: [['REST'], []] },
  )
  assert.deepEqual(capturedAnswers, [['REST'], []])
  await assert.rejects(
    () => router.execute(remoteActor(['question.write']), 'question.reply', { requestID: 'q1', answers: ['REST'] }),
    /must be an array of strings/,
  )
})

test('mobile contract commands expose host, workspace, and agent mode state', async () => {
  const router = new ControlRouter(stubController() as never)
  const scopes = ['session.read', 'session.write']

  // host.get composes identity + provider readiness for onboarding.
  const host = (await router.execute(remoteActor(scopes), 'host.get')) as Record<string, unknown>
  assert.equal(host.platform, process.platform)
  assert.equal(host.protocolVersion, 1)
  assert.equal(host.online, true)
  assert.deepEqual((host.provider as Record<string, unknown>).selectedProvider, 'anthropic')

  // Workspaces carry friendly display names, not raw paths as identity.
  const workspaces = (await router.execute(remoteActor(scopes), 'workspace.list')) as Array<Record<string, unknown>>
  assert.equal(workspaces.length, 1)
  assert.equal(workspaces[0]?.name, 'Cuppet')
  assert.equal(workspaces[0]?.pathDisplay, '~/Projects/Cuppet')

  await assert.rejects(
    () => router.execute(remoteActor(scopes), 'workspace.attach', { workspaceId: 'w_other' }),
    /unknown workspace/,
  )

  // Agent mode mirrors the native plan/build agents.
  assert.deepEqual(await router.execute(remoteActor(scopes), 'agent.mode.get'), { mode: 'build' })
  await router.execute(remoteActor(scopes), 'agent.mode.set', { agent: 'plan' })
})

test('public protocol events map from internal AgentEvents and drop internals', () => {
  const delta = publicEventFor({ type: 'text-delta', sessionID: 'ses_1', text: 'hi' } as unknown as AgentEvent)
  assert.deepEqual(delta, { type: 'assistant.text.delta', payload: { text: 'hi' } })
  assert.equal(publicEventFor({ type: 'tst-notification' } as unknown as AgentEvent), undefined)
})

test('command frames are validated, size-capped, and restricted to known types', () => {
  const frame = parseCommandFrame(
    JSON.stringify({ version: 1, id: 'm1', type: 'session.steer', hostId: 'h1', ts: 1, payload: { instruction: 'x' } }),
  )
  assert.equal(frame.id, 'm1')
  assert.throws(() => parseCommandFrame(JSON.stringify({ version: 2, id: 'm2', type: 'session.list', hostId: 'h1', ts: 1 })))
  assert.throws(() => parseCommandFrame(JSON.stringify({ version: 1, id: 'm3', type: 'memory.clear', hostId: 'h1', ts: 1 })))
  assert.throws(() => encodeFrame('x'.repeat(MAX_FRAME_BYTES + 1)))
  assert.equal(PROTOCOL_VERSION, 1)
})

test('pairing invites are single-use, expiring, and produce revocable device credentials', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.pairing-test-'))
  try {
    const invite = await createPairingInvite(dir)
    assert.ok(invite.expiresAt > Date.now())
    assert.equal(await claimPairingInvite(dir, 'WRONGCODE', 'phone'), undefined)

    const expired = await createPairingInvite(dir, { ttlMs: -1 })
    assert.equal(await claimPairingInvite(dir, expired.code, 'late phone'), undefined)

    const claimed = await claimPairingInvite(dir, invite.code, 'my phone')
    assert.ok(claimed)
    assert.ok(claimed.scopes.includes('session.write'))
    assert.equal(await claimPairingInvite(dir, invite.code, 'replay'), undefined)

    const auth = await authenticateDevice(dir, claimed.deviceId, claimed.secret)
    assert.ok(auth)
    assert.ok(auth.scopes.includes('permission.write'))
    assert.equal(await authenticateDevice(dir, claimed.deviceId, 'wrong-secret'), undefined)

    await revokeDevice(dir, claimed.deviceId)
    assert.equal(await authenticateDevice(dir, claimed.deviceId, claimed.secret), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('pairing URLs open the bundled relay app and translate websocket schemes', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.pairing-url-test-'))
  try {
    const invite = await createPairingInvite(dir, {
      relayUrl: 'wss://relay.example.test/',
      hostId: 'host_abc',
    })
    const url = new URL(invite.url ?? '')
    assert.equal(url.origin, 'https://relay.example.test')
    assert.equal(url.pathname, '/app')
    assert.equal(url.searchParams.get('code'), invite.code)
    assert.equal(url.searchParams.get('host'), 'host_abc')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('pairing URLs normalize relay websocket endpoints', async () => {
  const remoteDir = await mkdtemp(join(process.cwd(), '.pairing-url-ws-'))
  try {
    const invite = await createPairingInvite(remoteDir, {
      relayUrl: 'wss://relay.example.test/ws',
      hostId: 'host_url',
    })
    assert.equal(invite.url, `https://relay.example.test/app?code=${invite.code}&host=host_url`)
  } finally {
    await rm(remoteDir, { recursive: true, force: true })
  }
})

test('concurrent claims of one invite produce exactly one device', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.pairing-race-'))
  try {
    const invite = await createPairingInvite(dir)
    const [first, second] = await Promise.all([
      claimPairingInvite(dir, invite.code, 'phone A'),
      claimPairingInvite(dir, invite.code, 'phone B'),
    ])
    // Exactly one side wins; the loser must not receive valid credentials.
    assert.ok(first || second, 'one claim must succeed')
    const winner = (first ?? second)!
    const loser = first ? second : first
    assert.equal(loser, undefined)
    assert.notEqual(
      await authenticateDevice(dir, winner.deviceId, winner.secret),
      undefined,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

type Frame = Record<string, any>

class FakeTransport {
  connected = false
  readonly sent: string[] = []
  readonly #messages = new Set<(data: string) => void>()
  readonly #statuses = new Set<(connected: boolean) => void>()

  send(data: string): void { this.sent.push(data) }
  close(): void { this.connected = false }
  onMessage(listener: (data: string) => void): void { this.#messages.add(listener) }
  onStatusChange(listener: (connected: boolean) => void): void { this.#statuses.add(listener) }

  connect(): void {
    this.connected = true
    for (const listener of [...this.#statuses]) listener(true)
  }
  receive(value: unknown): void {
    for (const listener of [...this.#messages]) this.#receiveOne(JSON.stringify(value))
  }
  #receiveOne(data: string): void {
    for (const listener of [...this.#messages]) listener(data)
  }
  frames(): Frame[] {
    return this.sent.map((data) => JSON.parse(data))
  }
}

const settle = (): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, 25))

function command(id: string, type: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: PROTOCOL_VERSION, id, type, hostId: 'host_t', ts: Date.now(), payload, deviceId: 'dev_t' }
}

function startBridge(options: { scopes?: string[]; controller?: Record<string, unknown> } = {}): {
  bridge: RemoteBridge
  transport: FakeTransport
  agentListeners: Array<(event: AgentEvent) => void>
} {
  const transport = new FakeTransport()
  const agentListeners: Array<(event: AgentEvent) => void> = []
  const changeListeners: Array<() => void> = []
  const controller = stubController({
    onAgentEvent(listener: (event: AgentEvent) => void) { agentListeners.push(listener); return () => undefined },
    onChange(listener: () => void) { changeListeners.push(listener); return () => undefined },
    ...options.controller,
  }) as never
  const scopes = options.scopes ?? ['session.read', 'session.write', 'permission.write', 'question.write']
  const bridge = new RemoteBridge({
    controller,
    hostId: 'host_t',
    transport: transport as never,
    authenticateDevice: async (deviceId: string, secret: string) =>
      secret === 'good' ? { scopes, name: 'test' } : undefined,
    buildAttachSnapshot: async () => ({ snapshot: { ready: true }, permissions: [], questions: [] }),
  })
  bridge.start()
  return { bridge, transport, agentListeners }
}

function hello(): Record<string, unknown> {
  return { version: 1, type: 'device.hello', deviceId: 'dev_t', payload: { secret: 'good' } }
}

test('remote commands are rejected until a device authenticates', async () => {
  const { transport } = startBridge()
  transport.connect()
  await settle()

  transport.receive(command('c0', 'session.list'))
  await settle()
  const reject = transport.frames().find((frame) => frame.type === 'client.reject')
  assert.ok(reject, 'unauthenticated device must be rejected')

  transport.receive({ version: 1, type: 'device.hello', deviceId: 'dev_t', payload: { secret: 'bad' } })
  await settle()
  const failed = transport.frames().find((frame) => frame.replyTo === 'device-hello' && frame.ok === false)
  assert.ok(failed, 'bad credentials must fail the hello')
})

test('commands from unauthenticated devices fail fast with the command id', async () => {
  const { transport } = startBridge()
  transport.connect()
  await settle()

  transport.receive(command('early-1', 'session.list'))
  await settle()

  // The error must carry the sender's own id so clients do not hang.
  const reply = transport.frames().find((frame) => frame.replyTo === 'early-1')
  assert.equal(reply?.ok, false)
  assert.match(String(reply?.error), /not authenticated/)
})

test('authenticated devices execute commands and results route back to them', async () => {
  const { transport } = startBridge()
  transport.receive(hello())
  transport.connect()
  await settle()

  transport.receive(command('c1', 'session.list'))
  await settle()
  const accept = transport.frames().find((frame) => frame.type === 'client.accept')
  assert.ok(accept, 'valid credentials must be accepted')
  const reply = transport.frames().find((frame) => frame.replyTo === 'c1')
  assert.ok(reply?.ok)
  assert.deepEqual(reply.result, [{ id: 'ses_1' }])
  assert.equal(reply.deviceId, 'dev_t')
})

test('command ids are executed exactly once across retries', async () => {
  const { transport } = startBridge()
  transport.receive(hello())
  transport.connect()
  await settle()

  transport.receive(command('undo-1', 'session.new'))
  await settle()
  transport.receive(command('undo-1', 'session.new'))
  await settle()

  const replies = transport.frames().filter((frame) => frame.replyTo === 'undo-1')
  assert.equal(replies.length, 2)
  assert.ok(replies[0]?.ok)
  assert.equal(replies[1]?.result?.duplicate, true)
})

test('viewer-scoped devices cannot drive the session', async () => {
  const { transport } = startBridge({ scopes: ['session.read'] })
  transport.receive(hello())
  transport.connect()
  await settle()

  transport.receive(command('r1', 'session.list'))
  await settle()
  assert.ok(transport.frames().find((frame) => frame.replyTo === 'r1')?.ok)

  transport.receive(command('r2', 'session.abort'))
  await settle()
  const denied = transport.frames().find((frame) => frame.replyTo === 'r2')
  assert.equal(denied?.ok, false)
  assert.match(String(denied?.error), /missing scope/)
})

test('reconnect delivers attach snapshot first, then buffered offline events', async () => {
  const { bridge, transport } = startBridge()
  bridge.publish('assistant.text.delta', { text: 'queued' })
  transport.connect()
  await settle()

  const frames = transport.frames()
  assert.equal(frames[0]?.type, 'host.attach')
  assert.deepEqual(frames[0]?.payload?.snapshot, { ready: true })
  assert.equal(typeof frames[0]?.payload?.connectionId, 'string')
  const buffered = frames.find((frame) => frame.type === 'assistant.text.delta')
  assert.ok(buffered, 'offline-published event must be flushed after connect')
})

test('agent events stream as semantic protocol events with session ids', async () => {
  const { transport, agentListeners } = startBridge()
  transport.connect()
  await settle()
  assert.equal(agentListeners.length, 1)

  const emitAgentEvent = agentListeners[0]
  if (!emitAgentEvent) throw new Error('bridge did not subscribe to agent events')
  emitAgentEvent({ type: 'text-delta', sessionID: 'ses_1', text: 'hello' })
  emitAgentEvent({ type: 'tool-start', sessionID: 'ses_1', callID: 't1', name: 'bash' } as AgentEvent)
  await settle()

  const frames = transport.frames().filter((frame) => frame.type !== 'host.attach')
  assert.deepEqual(
    frames.map((frame) => [frame.type, frame.sessionId]),
    [['assistant.text.delta', 'ses_1'], ['tool.started', 'ses_1']],
  )
})
