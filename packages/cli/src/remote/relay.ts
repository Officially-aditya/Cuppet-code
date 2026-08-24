import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize } from 'node:path'

/**
 * Self-hostable Cuppet relay: one thin WebSocket "room" per host.
 *
 * Privacy posture: the relay routes envelopes and keeps presence plus a tiny
 * in-memory replay buffer only. Source code, credentials and durable session
 * state stay on the developer machine; clients fetch transcripts from the
 * host after reconnect (host.attach) rather than from the relay.
 *
 * Handshake (query params — TLS protects them; payload E2EE comes later):
 *   ws://…/ws?role=host&hostId=<id>&secret=<secret>
 *   ws://…/ws?role=device&hostId=<id>&deviceId=<id>&secret=<device secret>
 *
 * Hosts are checked against AUTH_FILE {"hosts":{"<hostId>":"<sha256(secret)>"}}.
 * Devices are authenticated END-TO-END by the host: the relay forwards the
 * device.hello envelope and only starts delivering live traffic once the host
 * answers with client.accept/client.reject for that deviceId.
 *
 * Management API (requires --admin-token):
 *   GET    /healthz
 *   POST   /hosts   {"hostId","secret"}   Authorization: Bearer <token>
 *   DELETE /hosts/<hostId>                Authorization: Bearer <token>
 */

const MAX_FRAME_BYTES = 512 * 1024
const REPLAY_LIMIT = 200
/** Per-connection message budget over a sliding window. */
const RATE_WINDOW_MS = 10_000
const RATE_LIMIT = 240

type SocketLike = {
  readyState: number
  send(data: string): void
  destroy(): void
}

type DeviceRegistration = {
  socket: SocketLike
  authenticated: boolean
}

export type RelayOptions = {
  port?: number
  bind?: string
  /** Directory served under /app (the remote-control PWA), if any. */
  appDirectory?: string
  /** JSON file mapping hostId → sha256(hostSecret). Absent/empty file = open dev mode. */
  authFile?: string
  /** When set, enables POST/DELETE /hosts management endpoints. */
  adminToken?: string
  /** Browser origins allowed to open WebSocket connections; empty allows all. */
  allowedOrigins?: readonly string[]
  maxDevicesPerRoom?: number
}

type Room = {
  host?: SocketLike | undefined
  devices: Map<string, DeviceRegistration>
  replay: Array<Record<string, unknown>>
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export class CuppetRelay {
  readonly #http: HttpServer
  readonly #rooms = new Map<string, Room>()
  readonly #options: RelayOptions

  constructor(options: RelayOptions = {}) {
    this.#options = options
    this.#http = createServer((request, response) => void this.#handleHttp(request, response))
    this.#http.on('upgrade', (request, socket) => this.#handleUpgrade(request, socket))
  }

  get port(): number {
    const address = this.#http.address()
    return typeof address === 'object' && address ? address.port : (this.#options.port ?? 0)
  }

  async listen(port: number, bind?: string): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      this.#http.once('error', rejectPromise)
      this.#http.listen(port, bind ?? this.#options.bind ?? '0.0.0.0', () => resolvePromise())
    })
  }

  close(): void {
    this.#http.close()
    for (const room of this.#rooms.values()) {
      room.host?.destroy()
      for (const device of room.devices.values()) device.socket.destroy()
    }
    this.#rooms.clear()
  }

  async #loadAuthorizedHosts(): Promise<Record<string, string> | undefined> {
    if (!this.#options.authFile) return undefined
    try {
      const parsed = JSON.parse(await readFile(this.#options.authFile, 'utf8')) as {
        hosts?: Record<string, string>
      }
      return parsed.hosts ?? {}
    } catch {
      return {}
    }
  }

  async #handleHttp(request: IncomingMessage, response: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname === '/healthz') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
      return
    }
    const isHostManagement = (request.method === 'POST' && url.pathname === '/hosts') ||
      (request.method === 'DELETE' && url.pathname.startsWith('/hosts/'))
    if (isHostManagement) {
      if (!this.#authorizeAdmin(request)) {
        response.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized\n')
        return
      }
      if (request.method === 'POST') {
        let body = ''
        request.on('data', (chunk: string) => {
          body += chunk
          if (body.length > 16_384) request.destroy()
        })
        request.on('end', () => {
          void this.#upsertHost(body).then((ok) => {
            response.writeHead(ok ? 200 : 400).end(ok ? 'ok\n' : 'bad request\n')
          })
        })
        return
      }
      const hostId = decodeURIComponent(url.pathname.slice('/hosts/'.length))
      response.writeHead(200).end(`${await this.#removeHost(hostId) ? 'removed' : 'unknown'}\n`)
      return
    }
    if (!this.#options.appDirectory || !url.pathname.startsWith('/app')) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('cuppet relay\n')
      return
    }
    const relative = url.pathname === '/app' ? '/index.html' : url.pathname.slice('/app'.length)
    const safe = normalize(relative).replace(/^([.][.][/\\])+/, '')
    try {
      const body = await readFile(join(this.#options.appDirectory, safe))
      const types: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.webmanifest': 'application/manifest+json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
      }
      response.writeHead(200, { 'content-type': types[extname(safe)] ?? 'application/octet-stream' }).end(body)
    } catch {
      response.writeHead(404).end('not found')
    }
  }

  #authorizeAdmin(request: IncomingMessage): boolean {
    if (!this.#options.adminToken) return false
    const header = request.headers.authorization ?? ''
    const provided = Buffer.from(header.replace(/^Bearer\s+/i, ''))
    const expected = Buffer.from(this.#options.adminToken)
    return provided.length === expected.length && timingSafeEqual(provided, expected)
  }

  async #upsertHost(body: string): Promise<boolean> {
    if (!this.#options.authFile) return false
    try {
      const parsed = JSON.parse(body) as { hostId?: unknown; secret?: unknown }
      if (typeof parsed.hostId !== 'string' || !/^[\w.-]{1,128}$/.test(parsed.hostId)) return false
      if (typeof parsed.secret !== 'string' || parsed.secret.length < 16) return false
      const current = (await this.#loadAuthorizedHosts()) ?? {}
      current[parsed.hostId] = sha256(parsed.secret)
      const { mkdir, writeFile } = await import('node:fs/promises')
      await mkdir(dirname(this.#options.authFile), { recursive: true, mode: 0o700 })
      await writeFile(this.#options.authFile, `${JSON.stringify({ hosts: current }, null, 2)}\n`, { mode: 0o600 })
      return true
    } catch {
      return false
    }
  }

  async #removeHost(hostId: string): Promise<boolean> {
    if (!this.#options.authFile || !/^[\w.-]{1,128}$/.test(hostId)) return false
    const current = (await this.#loadAuthorizedHosts()) ?? {}
    if (!(hostId in current)) return false
    delete current[hostId]
    const { writeFile } = await import('node:fs/promises')
    await writeFile(this.#options.authFile, `${JSON.stringify({ hosts: current }, null, 2)}\n`, { mode: 0o600 })
    return true
  }

  async #handleUpgrade(request: IncomingMessage, rawSocket: import('node:stream').Duplex): Promise<void> {
    const socket = rawSocket as import('node:net').Socket
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname !== '/ws') {
      socket.destroy()
      return
    }
    const origins = this.#options.allowedOrigins ?? []
    if (origins.length > 0) {
      const origin = request.headers.origin
      if (origin && !origins.includes(origin)) {
        socket.destroy()
        return
      }
    }
    const key = request.headers['sec-websocket-key']
    if (!key) {
      socket.destroy()
      return
    }
    const acceptKey = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`,
    )
    socket.setNoDelay(true)

    // Sliding-window message budget per connection; abusive peers are dropped.
    let windowStart = Date.now()
    let messageCount = 0
    const overBudget = (): boolean => {
      const now = Date.now()
      if (now - windowStart >= RATE_WINDOW_MS) {
        windowStart = now
        messageCount = 0
      }
      messageCount += 1
      return messageCount > RATE_LIMIT
    }

    const role = url.searchParams.get('role')
    const hostId = url.searchParams.get('hostId') ?? ''
    let deviceId: string | undefined
    let room: Room | undefined
    /** This connection's registration; stale close events must not evict successors. */
    let selfRegistration: SocketLike | DeviceRegistration | undefined

    if (role === 'host') {
      const secret = url.searchParams.get('secret') ?? ''
      const expected = await this.#loadAuthorizedHosts()
      // Open (development) mode when no auth file exists or it has no entries.
      if (expected && Object.keys(expected).length > 0) {
        const stored = expected[hostId]
        const provided = Buffer.from(sha256(secret))
        const storedBuffer = Buffer.from(stored ?? '')
        if (!stored || provided.length !== storedBuffer.length || !timingSafeEqual(provided, storedBuffer)) {
          closeSocket(socket, 4002, 'host unauthorized')
          return
        }
      }
      room = this.#room(hostId)
      // Replace any previous host, but remember our own wrapper so a delayed
      // 'close' from the OLD socket cannot unregister the NEW one below.
      selfRegistration = this.#wrap(socket)
      room.host?.destroy()
      // A replacement host is a new authority. Do not let devices remain
      // authenticated against the old process or replay its event history.
      for (const device of room.devices.values()) device.socket.destroy()
      room.devices.clear()
      room.replay.length = 0
      room.host = selfRegistration
    } else if (role === 'device') {
      room = this.#room(hostId)
      deviceId = url.searchParams.get('deviceId') ?? ''
      const maxDevices = this.#options.maxDevicesPerRoom ?? 8
      if (!deviceId || deviceId.length > 128 || (!room.devices.has(deviceId) && room.devices.size >= maxDevices)) {
        closeSocket(socket, 4003, 'invalid device')
        return
      }
      if (!room.host) {
        // Tell the client why instead of leaving an opaque 1006 hangup.
        closeSocket(socket, 4001, 'host offline')
        return
      }
      const registration: DeviceRegistration = {
        socket: this.#wrap(socket),
        authenticated: false,
      }
      const previous = room.devices.get(deviceId)
      previous?.socket.destroy()
      room.devices.set(deviceId, registration)
      selfRegistration = registration

      // Forward credentials end-to-end; the host decides. Connections without
      // a secret param are pairing sockets that authenticate via device.pair.
      const secret = url.searchParams.get('secret')
      if (secret !== null) {
        room.host.send(JSON.stringify({
          version: 1,
          seq: 0,
          hostId,
          ts: Date.now(),
          type: 'device.hello',
          deviceId,
          payload: { deviceId, secret },
        }))
      }
    } else {
      socket.destroy()
      return
    }

    let buffered = Buffer.alloc(0)
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      for (;;) {
        let decoded: { opcode: number; payload: Buffer; consumed: number } | undefined
        try {
          decoded = decodeFrame(buffered)
        } catch {
          socket.destroy()
          return
        }
        if (!decoded) break
        buffered = buffered.subarray(decoded.consumed)
        if (decoded.opcode === 0x8) {
          socket.destroy()
          return
        }
        if (decoded.opcode === 0x9) {
          // RFC 6455: answer pings so intermediaries keep the socket healthy.
          writeFrame(socket, 0xa, decoded.payload)
          continue
        }
        if (decoded.opcode !== 0x1) continue
        if (overBudget()) {
          socket.destroy()
          return
        }
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(decoded.payload.toString('utf8')) as Record<string, unknown>
        } catch {
          continue
        }
        this.#dispatch(role ?? '', hostId, deviceId ?? '', parsed, selfRegistration)
      }
    })
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      if (role === 'host') {
        // Only tear the room down if WE are still its host — a replacement
        // host may already have taken over when this close event fires.
        if (room && room.host === selfRegistration) {
          room.devices.forEach((device) => device.socket.destroy())
          room.devices.clear()
          room.host = undefined
        }
        return
      }
      if (room && deviceId && room.devices.get(deviceId) === selfRegistration) {
        room.devices.delete(deviceId)
      }
    })
  }

  #dispatch(
    role: string,
    hostId: string,
    deviceId: string,
    message: Record<string, unknown>,
    registration?: SocketLike | DeviceRegistration,
  ): void {
    const room = this.#rooms.get(hostId)
    if (!room) return
    const type = String(message.type ?? '')

    if (role === 'device') {
      // Device frames (commands/results of hello) go to the host verbatim.
      const host = room.host
      const device = room.devices.get(deviceId)
      if (!host || !device || device !== registration) return
      if (type === 'ping') return
      // A pairing socket may redeem its invite, but it must not be able to
      // send arbitrary commands before the host has accepted its credentials.
      if (!device.authenticated && type !== 'device.pair') return
      host.send(JSON.stringify({ ...message, deviceId }))
      return
    }

    // A replaced host may still have buffered bytes in its socket. Do not let
    // that stale authority publish into the new host's room.
    if (room.host !== registration) return
    // Host frames.
    if (type === 'client.accept' || type === 'client.reject') {
      const target = String(message.deviceId ?? '')
      const device = room.devices.get(target)
      if (!device) return
      if (type === 'client.reject') {
        device.authenticated = false
        device.socket.send(JSON.stringify(message))
        device.socket.destroy()
        room.devices.delete(target)
        return
      }
      // Accepted: tell the device, deliver the replay buffer, then go live.
      device.authenticated = true
      device.socket.send(JSON.stringify(message))
      for (const frame of room.replay) device.socket.send(JSON.stringify(frame))
      return
    }
    if (type.startsWith('command.result') || message.replyTo !== undefined) {
      // Route replies back to the requesting device only.
      const target = String(message.deviceId ?? '')
      if (target) {
        const device = room.devices.get(target)
        if (device) {
          device.socket.send(JSON.stringify(message))
        }
      }
      // Never broadcast replies. A missing target is a dropped reply, not a
      // reason to expose command results to every connected device.
      return
    }
    if (type === 'device.paired') {
      const target = String(message.deviceId ?? '')
      const device = room.devices.get(target)
      if (device) device.socket.send(JSON.stringify(message))
      return
    }
    for (const device of [...room.devices.values()]) {
      if (device.authenticated) device.socket.send(JSON.stringify(message))
    }
    if (isReplayableEvent(type) && typeof message.seq === 'number') {
      room.replay.push(message)
      if (room.replay.length > REPLAY_LIMIT) room.replay.shift()
    }
  }

  #room(hostId: string): Room {
    let room = this.#rooms.get(hostId)
    if (!room) {
      room = { devices: new Map(), replay: [] }
      this.#rooms.set(hostId, room)
    }
    return room
  }

  #wrap(socket: import('node:net').Socket): SocketLike {
    const wrapped: SocketLike = {
      readyState: 1,
      send(data: string) {
        writeFrame(socket, 0x1, Buffer.from(data, 'utf8'))
      },
      destroy() {
        socket.destroy()
      },
    }
    return wrapped
  }
}

function isReplayableEvent(type: string): boolean {
  return type !== 'client.accept' && type !== 'client.reject' && type !== 'device.paired'
}

function writeFrame(socket: import('node:net').Socket, opcode: number, payload: Buffer): void {
  const length = payload.length
  let header: Buffer
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length])
  } else if (length < 65_536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  socket.write(Buffer.concat([header, payload]))
}

/** RFC 6455 server-initiated close so clients learn why they were refused. */
function closeSocket(socket: import('node:net').Socket, code: number, reason: string): void {
  const reasonBytes = Buffer.from(reason.slice(0, 100), 'utf8')
  const payload = Buffer.alloc(2 + reasonBytes.length)
  payload.writeUInt16BE(code, 0)
  reasonBytes.copy(payload, 2)
  try {
    writeFrame(socket, 0x8, payload)
  } catch {
    // socket already gone
  }
  socket.destroy()
}

function decodeFrame(buffer: Buffer): { opcode: number; payload: Buffer; consumed: number } | undefined {
  if (buffer.length < 2) return undefined
  const first = buffer[0]
  const second = buffer[1]
  if (first === undefined || second === undefined) return undefined
  const opcode = first & 0x0f
  const masked = (second & 0x80) !== 0
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return undefined
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return undefined
    const big = buffer.readBigUInt64BE(2)
    if (big > BigInt(MAX_FRAME_BYTES)) throw new Error('frame too large')
    length = Number(big)
    offset = 10
  }
  const maskLength = masked ? 4 : 0
  if (buffer.length < offset + maskLength + length) return undefined
  let payload = buffer.subarray(offset + maskLength, offset + maskLength + length)
  if (masked) {
    const mask = buffer.subarray(offset, offset + maskLength)
    const unmasked = Buffer.alloc(length)
    for (let index = 0; index < length; index += 1) {
      const payloadByte = payload[index]
      const maskByte = mask[index % 4]
      if (payloadByte === undefined || maskByte === undefined) break
      unmasked[index] = payloadByte ^ maskByte
    }
    payload = unmasked
  }
  return { opcode, payload, consumed: offset + maskLength + length }
}

/** Random secret generator shared by CLI enrollment helpers. */
export function generateSecret(): string {
  return randomBytes(32).toString('base64url')
}
