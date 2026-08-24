import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { RemoteBridge } from '../src/remote/bridge.js'
import { WebSocketTransport } from '../src/remote/connection.js'
import {
  authenticateDevice,
  claimPairingInvite,
  createPairingInvite,
} from '../src/remote/pairing.js'
import { CuppetRelay } from '../src/remote/relay.js'

type Frame = Record<string, any>

/** Minimal device-side WebSocket client mirroring what the PWA does. */
class DeviceClient {
  readonly frames: Frame[] = []
  readonly socket: WebSocket

  constructor(url: string) {
    this.socket = new WebSocket(url)
    this.socket.addEventListener('message', (event) => {
      try {
        this.frames.push(JSON.parse(String(event.data)))
      } catch {
        // ignore malformed frames
      }
    })
  }

  send(value: unknown): void {
    try {
      this.socket.send(JSON.stringify(value))
    } catch (error) {
      if (process.env.DEBUG_DEVICE) {
        console.log('SEND FAILED readyState=', this.socket.readyState, (error as Error).message)
      }
      throw error
    }
  }

  close(): void {
    try {
      this.socket.close()
    } catch {
      // already closed
    }
  }

  async open(timeoutMs = 4000): Promise<void> {
    this.socket.addEventListener('close', (event) => {
      if (process.env.DEBUG_DEVICE) console.log('DEVICE CLOSED EARLY', event.code, JSON.stringify(event.reason))
    })
    await waitFor(() => this.socket.readyState === WebSocket.OPEN, timeoutMs, 'device open')
    if (process.env.DEBUG_DEVICE) console.log('DEVICE OPENED')
  }

  async next(
    predicate: (frame: Frame) => boolean,
    label = 'frame',
    timeoutMs = 5000,
  ): Promise<Frame> {
    const found = await waitFor(() => this.frames.find(predicate), timeoutMs, label)
    return found as Frame
  }
}

async function waitFor<T>(
  produce: () => T | undefined | false,
  timeoutMs: number,
  label: string,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = produce()
    if (value !== undefined && value !== false) return value as NonNullable<T>
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
  }
}

const settle = (): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, 60))

function hostUrl(port: number, hostId: string, secret?: string): string {
  const params = new URLSearchParams({ role: 'host', hostId })
  if (secret !== undefined) params.set('secret', secret)
  return `ws://127.0.0.1:${port}/ws?${params}`
}

function deviceUrl(port: number, hostId: string, deviceId: string, secret?: string): string {
  const params = new URLSearchParams({ role: 'device', hostId, deviceId })
  if (secret !== undefined) params.set('secret', secret)
  return `ws://127.0.0.1:${port}/ws?${params}`
}

function stubController(): Record<string, unknown> {
  let counter = 0
  return {
    async listSessions() { return [{ id: 'ses_a', title: 'first' }] },
    async status() { return { running: false } },
    async listPendingPermissions() { return [] },
    async listPendingQuestions() { return [] },
    async newSession() { counter += 1 },
    onAgentEvent() { return () => undefined },
    onChange() { return () => undefined },
    get snapshot() { return { models: [], running: false } },
  }
}

function startBridge(relayPort: number, hostId: string, remoteDir: string, hostSecret?: string): {
  bridge: RemoteBridge
  transport: WebSocketTransport
} {
  const transport = new WebSocketTransport(hostUrl(relayPort, hostId, hostSecret))
  const bridge = new RemoteBridge({
    controller: stubController() as never,
    hostId,
    transport,
    authenticateDevice: (deviceId, secret) => authenticateDevice(remoteDir, deviceId, secret),
    claimPairingInvite: (code, name) => claimPairingInvite(remoteDir, code, name),
  })
  bridge.start()
  return { bridge, transport }
}

/** Devices may only join a room whose host is already dialed in. */
async function waitHostOnline(transport: WebSocketTransport): Promise<void> {
  await waitFor(() => transport.connected ? true : undefined, 5000, 'host transport connect')
}

test('relay routes commands between an authenticated device and the host bridge end to end', async () => {
  const relay = new CuppetRelay()
  await relay.listen(0)
  const remoteDir = await mkdtemp(join(process.cwd(), '.relay-e2e-'))
  let bridge: RemoteBridge | undefined
  let device: DeviceClient | undefined
  try {
    const invite = await createPairingInvite(remoteDir)
    const claimed = await claimPairingInvite(remoteDir, invite.code, 'e2e phone')
    assert.ok(claimed)

    const { bridge: hostBridge, transport } = startBridge(relay.port, 'host_e2e', remoteDir)
    bridge = hostBridge
    await waitHostOnline(transport)

    device = new DeviceClient(deviceUrl(relay.port, 'host_e2e', claimed.deviceId, claimed.secret))
    await device.open()

    const accepted = await device.next((frame) => frame.replyTo === 'device-hello' && frame.ok === true, 'hello accept')
    assert.equal(String(accepted.result?.scopes ?? []).includes('session.write'), true)

    // Replay buffer delivers host.attach even though the device joined late.
    const attach = await device.next((frame) => frame.type === 'host.attach', 'attach replay')
    assert.equal(typeof attach.payload?.connectionId, 'string')

    device.send({
      version: 1, id: 'cmd-a', type: 'session.list', ts: Date.now(),
      payload: {},
    })
    const result = await device.next((frame) => frame.replyTo === 'cmd-a', 'session.list result')
    assert.equal(result.ok, true)
    assert.deepEqual(result.result, [{ id: 'ses_a', title: 'first' }])
  } finally {
    device?.close()
    bridge?.stop()
    relay.close()
    await rm(remoteDir, { recursive: true, force: true })
  }
})

test('relay does not deliver host state to a device before host authentication', async () => {
  const relay = new CuppetRelay()
  await relay.listen(0)
  const remoteDir = await mkdtemp(join(process.cwd(), '.relay-auth-gate-'))
  let bridge: RemoteBridge | undefined
  let device: DeviceClient | undefined
  try {
    const { bridge: hostBridge, transport } = startBridge(relay.port, 'host_auth_gate', remoteDir)
    bridge = hostBridge
    await waitHostOnline(transport)

    device = new DeviceClient(deviceUrl(relay.port, 'host_auth_gate', 'pending-device'))
    await device.open()
    await settle()
    assert.equal(device.frames.some((frame) => frame.type === 'host.attach'), false)

    bridge.publish('assistant.text.delta', { text: 'private' })
    await settle()
    assert.equal(device.frames.some((frame) => frame.type === 'assistant.text.delta'), false)

    // Pairing sockets may redeem an invite, but cannot probe the host command
    // surface before the host accepts their credentials.
    device.send({ version: 1, id: 'unauth-list', type: 'session.list', ts: Date.now(), payload: {} })
    await settle()
    assert.equal(device.frames.some((frame) => frame.replyTo === 'unauth-list'), false)
  } finally {
    device?.close()
    bridge?.stop()
    relay.close()
    await rm(remoteDir, { recursive: true, force: true })
  }
})

test('relay and bridge isolate scopes for multiple authenticated devices', async () => {
  const relay = new CuppetRelay()
  await relay.listen(0)
  const remoteDir = await mkdtemp(join(process.cwd(), '.relay-device-scopes-'))
  let bridge: RemoteBridge | undefined
  const devices: DeviceClient[] = []
  try {
    const trustedInvite = await createPairingInvite(remoteDir)
    const viewerInvite = await createPairingInvite(remoteDir, { role: 'viewer' })
    const trusted = await claimPairingInvite(remoteDir, trustedInvite.code, 'trusted')
    const viewer = await claimPairingInvite(remoteDir, viewerInvite.code, 'viewer')
    assert.ok(trusted)
    assert.ok(viewer)

    const started = startBridge(relay.port, 'host_device_scopes', remoteDir)
    bridge = started.bridge
    await waitHostOnline(started.transport)

    const trustedDevice = new DeviceClient(deviceUrl(relay.port, 'host_device_scopes', trusted.deviceId, trusted.secret))
    const viewerDevice = new DeviceClient(deviceUrl(relay.port, 'host_device_scopes', viewer.deviceId, viewer.secret))
    devices.push(trustedDevice, viewerDevice)
    await Promise.all([trustedDevice.open(), viewerDevice.open()])
    await Promise.all([
      trustedDevice.next((frame) => frame.replyTo === 'device-hello' && frame.ok === true, 'trusted hello'),
      viewerDevice.next((frame) => frame.replyTo === 'device-hello' && frame.ok === true, 'viewer hello'),
    ])

    viewerDevice.send({ version: 1, id: 'viewer-abort', type: 'session.abort', ts: Date.now(), payload: {} })
    const denied = await viewerDevice.next((frame) => frame.replyTo === 'viewer-abort', 'viewer scope denial')
    assert.equal(denied.ok, false)
    assert.match(String(denied.error), /missing scope/)

    trustedDevice.send({ version: 1, id: 'trusted-list', type: 'session.list', ts: Date.now(), payload: {} })
    const allowed = await trustedDevice.next((frame) => frame.replyTo === 'trusted-list', 'trusted command')
    assert.equal(allowed.ok, true)
  } finally {
    for (const device of devices) device.close()
    bridge?.stop()
    relay.close()
    await rm(remoteDir, { recursive: true, force: true })
  }
})

test('pairing over the wire claims single-use invites and rejects bad codes', async () => {
  const relay = new CuppetRelay()
  await relay.listen(0)
  const remoteDir = await mkdtemp(join(process.cwd(), '.relay-pair-'))
  let bridge: RemoteBridge | undefined
  let device: DeviceClient | undefined
  try {
    const invite = await createPairingInvite(remoteDir, { ttlMs: 30_000 })
    const { bridge: hostBridge, transport } = startBridge(relay.port, 'host_pair', remoteDir)
    bridge = hostBridge
    await waitHostOnline(transport)

    // Pairing sockets carry no secret param so the relay skips auto-hello.
    device = new DeviceClient(deviceUrl(relay.port, 'host_pair', 'pair-device'))
    await device.open()

    device.send({ version: 1, id: 'p0', type: 'device.pair', ts: Date.now(), payload: { code: 'NOPE', name: 'x' } })
    const bad = await device.next((frame) => frame.replyTo === 'device-pair' && frame.ok === false, 'bad code reject')
    assert.match(String(bad.error), /invalid or expired/)

    device.send({ version: 1, id: 'p1', type: 'device.pair', ts: Date.now(), payload: { code: invite.code, name: 'phone' } })
    const good = await device.next((frame) => frame.replyTo === 'device-pair' && frame.ok === true, 'claim')
    assert.ok(good.result?.deviceId)
    assert.ok(good.result?.secret)
    const pairedEvent = await device.next((frame) => frame.type === 'device.paired', 'paired event')
    assert.equal(pairedEvent.payload?.deviceId, good.result?.deviceId)

    const authenticated = await authenticateDevice(remoteDir, String(good.result?.deviceId), String(good.result?.secret))
    assert.ok(authenticated)
    assert.equal(await claimPairingInvite(remoteDir, invite.code, 'replay'), undefined)

    // Fresh credentials work against the normal hello flow.
    device.close()
    device = new DeviceClient(deviceUrl(relay.port, 'host_pair', String(good.result?.deviceId), String(good.result?.secret)))
    await device.open()
    await device.next((frame) => frame.type === 'client.accept', 'accept after pair')
  } finally {
    device?.close()
    bridge?.stop()
    relay.close()
    await rm(remoteDir, { recursive: true, force: true })
  }
})

test('relay enforces host secrets enrolled through the admin endpoint', async () => {
  const authFile = join(process.cwd(), `.relay-auth-${Date.now()}.json`)
  const adminToken = 'admin-token-e2e'
  const relay = new CuppetRelay({ authFile, adminToken })
  await relay.listen(0)
  const remoteDir = await mkdtemp(join(process.cwd(), '.relay-admin-'))
  let bridge: RemoteBridge | undefined
  let device: DeviceClient | undefined
  try {
    const enroll = await fetch(`http://127.0.0.1:${relay.port}/hosts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ hostId: 'host_enrolled', secret: 'a-sufficiently-long-secret' }),
    })
    assert.equal(enroll.status, 200)

    const unauthorized = await fetch(`http://127.0.0.1:${relay.port}/hosts`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: JSON.stringify({ hostId: 'host_evil', secret: 'another-long-secret' }),
    })
    assert.equal(unauthorized.status, 401)

    const invite = await createPairingInvite(remoteDir)
    const claimed = await claimPairingInvite(remoteDir, invite.code, 'admin phone')
    assert.ok(claimed)

    const { bridge: hostBridge, transport } = startBridge(relay.port, 'host_enrolled', remoteDir, 'a-sufficiently-long-secret')
    bridge = hostBridge
    await waitHostOnline(transport)
    device = new DeviceClient(deviceUrl(relay.port, 'host_enrolled', claimed!.deviceId, claimed!.secret))
    await device.open()
    await device.next((frame) => frame.type === 'client.accept' && frame.deviceId === claimed!.deviceId, 'accepted with valid host secret')

    // A host presenting a bad secret completes the HTTP handshake but is
    // closed by the relay immediately afterwards (close code 4002).
    const intruder = new WebSocket(hostUrl(relay.port, 'host_enrolled', 'wrong-secret'))
    const outcome = await new Promise<string>((resolvePromise) => {
      const timer = setTimeout(() => resolvePromise('timeout'), 3000)
      intruder.addEventListener('open', () => undefined)
      intruder.addEventListener('close', (event) => {
        clearTimeout(timer)
        resolvePromise(`closed:${event.code}`)
      })
      intruder.addEventListener('error', () => undefined)
    })
    assert.match(outcome, /^closed:/, 'wrong-secret host must be closed by the relay')

    const removed = await fetch(`http://127.0.0.1:${relay.port}/hosts/host_enrolled`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${adminToken}` },
    })
    assert.equal(removed.status, 200)
  } finally {
    device?.close()
    bridge?.stop()
    relay.close()
    await rm(remoteDir, { recursive: true, force: true })
    await rm(authFile, { force: true })
  }
})

test('agent events stream from the host through the relay to devices', async () => {
  const relay = new CuppetRelay()
  await relay.listen(0)
  const remoteDir = await mkdtemp(join(process.cwd(), '.relay-events-'))
  let agentPush: ((event: unknown) => void) | undefined
  let bridge: RemoteBridge | undefined
  let device: DeviceClient | undefined
  try {
    const invite = await createPairingInvite(remoteDir)
    const claimed = await claimPairingInvite(remoteDir, invite.code, 'events phone')
    assert.ok(claimed)

    const controller = stubController()
    controller.onAgentEvent = (listener: (event: unknown) => void) => {
      agentPush = listener
      return () => undefined
    }
    const transport = new WebSocketTransport(hostUrl(relay.port, 'host_events'))
    bridge = new RemoteBridge({
      controller: controller as never,
      hostId: 'host_events',
      transport,
      authenticateDevice: (id, secret) => authenticateDevice(remoteDir, id, secret),
    })
    bridge.start()
    await waitHostOnline(transport)

    device = new DeviceClient(deviceUrl(relay.port, 'host_events', claimed!.deviceId, claimed!.secret))
    await device.open()
    await device.next((frame) => frame.replyTo === 'device-hello' && frame.ok === true, 'hello')

    agentPush?.({ type: 'text-delta', sessionID: 'ses_9', text: 'streamed' })
    agentPush?.({ type: 'permission', request: { id: 'perm_1', sessionID: 'ses_9', action: 'bash', resources: ['npm test'] } })
    const delta = await device.next((frame) => frame.type === 'assistant.text.delta', 'text delta')
    assert.equal(delta.sessionId, 'ses_9')
    const permissionEvent = await device.next((frame) => frame.type === 'permission.requested', 'permission event')
    assert.equal(permissionEvent.payload?.request?.id, 'perm_1')
  } finally {
    device?.close()
    bridge?.stop()
    relay.close()
    await rm(remoteDir, { recursive: true, force: true })
  }
})

test('a reconnecting host replaces the old one without devices being dropped by its stale close', async () => {
  const relay = new CuppetRelay()
  await relay.listen(0)
  const remoteDir = await mkdtemp(join(process.cwd(), '.relay-replace-'))
  let device: DeviceClient | undefined
  let oldTransport: WebSocketTransport | undefined
  let newTransport: WebSocketTransport | undefined
  const makeBridge = (hostId: string): { bridge: RemoteBridge; transport: WebSocketTransport } => {
    const transport = new WebSocketTransport(hostUrl(relay.port, hostId))
    const bridge = new RemoteBridge({
      controller: stubController() as never,
      hostId,
      transport,
      authenticateDevice: (id, secret) => authenticateDevice(remoteDir, id, secret),
    })
    bridge.start()
    return { bridge, transport }
  }
  try {
    const invite = await createPairingInvite(remoteDir)
    const claimed = await claimPairingInvite(remoteDir, invite.code, 'replacement phone')
    assert.ok(claimed)

    const first = makeBridge('host_replace')
    oldTransport = first.transport
    await waitHostOnline(oldTransport)

    device = new DeviceClient(deviceUrl(relay.port, 'host_replace', claimed!.deviceId, claimed!.secret))
    await device.open()
    await device.next((frame) => frame.replyTo === 'device-hello' && frame.ok === true, 'hello via first host')

    // Second host process takes over the room while the FIRST socket is
    // still open. The relay destroys it; its close event must NOT evict the
    // new registration or kill connected devices.
    const second = makeBridge('host_replace')
    newTransport = second.transport
    await waitHostOnline(newTransport)
    first.bridge.stop()
    await settle()

    // The new host does not know previously-authenticated devices (auth is
    // host-local), so the device re-handshakes — exactly what the PWA does.
    device.close()
    device = new DeviceClient(deviceUrl(relay.port, 'host_replace', claimed!.deviceId, claimed!.secret))
    await device.open()
    await device.next((frame) => frame.replyTo === 'device-hello' && frame.ok === true, 'hello via replacement host')

    // The surviving room must route: commands reach the NEW host and reply.
    device.send({ version: 1, id: 'cmd-r', type: 'session.list', ts: Date.now(), payload: {} })
    const result = await device.next((frame) => frame.replyTo === 'cmd-r', 'result after host replacement')
    assert.equal(result.ok, true)
    assert.equal(device.socket.readyState, WebSocket.OPEN)
  } finally {
    device?.close()
    oldTransport?.close()
    newTransport?.close()
    relay.close()
    await rm(remoteDir, { recursive: true, force: true })
  }
})
