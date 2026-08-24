import { randomBytes } from 'node:crypto'

/**
 * Transport abstraction so RemoteBridge logic is testable without sockets.
 * The production transport is an outbound-only WebSocket to the relay: the
 * host dials out, opens no inbound port, and never exposes the control socket.
 */
export interface RemoteTransport {
  /** Begins connecting; idempotent. Optional for transports that are born connected. */
  start?(): void
  send(data: string): void
  close(): void
  readonly connected: boolean
  onMessage(listener: (data: string) => void): void
  onStatusChange(listener: (connected: boolean) => void): void
}

export type TransportFactory = (onMessage: (data: string) => void, onStatusChange: (connected: boolean) => void) => RemoteTransport

const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
const HEARTBEAT_MS = 20_000
/** Frames queued while the socket is down are flushed on reconnect. */
const OFFLINE_BUFFER_LIMIT = 256
/** Relay close code meaning the host is not currently connected. */
export const CLOSE_HOST_OFFLINE = 4001

export class WebSocketTransport implements RemoteTransport {
  #socket: WebSocket | undefined
  #heartbeat: ReturnType<typeof setInterval> | undefined
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined
  #closed = false
  #connected = false
  readonly #url: string
  readonly #messageListeners = new Set<(data: string) => void>()
  readonly #statusListeners = new Set<(connected: boolean) => void>()
  #buffered: string[] = []

  constructor(url: string) {
    this.#url = url
  }

  get connected(): boolean {
    return this.#connected
  }

  onMessage(listener: (data: string) => void): void {
    this.#messageListeners.add(listener)
  }

  onStatusChange(listener: (connected: boolean) => void): void {
    this.#statusListeners.add(listener)
  }

  start(): void {
    this.#dial()
  }

  send(data: string): void {
    if (this.#socket && this.#connected && this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.send(data)
      return
    }
    // Queue while offline; newest state wins when the cap is exceeded.
    this.#buffered.push(data)
    if (this.#buffered.length > OFFLINE_BUFFER_LIMIT) this.#buffered.shift()
  }

  close(): void {
    this.#closed = true
    if (this.#heartbeat) clearInterval(this.#heartbeat)
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
    try {
      this.#socket?.close()
    } catch {}
  }

  #setStatus(connected: boolean): void {
    if (this.#connected === connected) return
    this.#connected = connected
    for (const listener of this.#statusListeners) listener(connected)
  }

  #flushBuffer(): void {
    const frames = this.#buffered.splice(0)
    for (const frame of frames) {
      if (this.#socket && this.#socket.readyState === WebSocket.OPEN) this.#socket.send(frame)
    }
  }

  #dial(attempt = 0): void {
    if (this.#closed) return
    let socket: WebSocket
    try {
      socket = new WebSocket(this.#url)
    } catch {
      this.#scheduleReconnect(attempt)
      return
    }
    socket.addEventListener('open', () => {
      this.#socket = socket
      this.#setStatus(true)
      this.#heartbeat = setInterval(() => {
        try {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ v: 1, type: 'ping' }))
        } catch {}
      }, HEARTBEAT_MS)
      this.#flushBuffer()
    })
    socket.addEventListener('message', (event) => {
      const data = typeof event.data === 'string' ? event.data : ''
      for (const listener of this.#messageListeners) listener(data)
    })
    socket.addEventListener('close', () => {
      if (this.#heartbeat) clearInterval(this.#heartbeat)
      this.#setStatus(false)
      this.#scheduleReconnect(attempt + 1)
    })
    socket.addEventListener('error', () => {
      try {
        socket.close()
      } catch {}
    })
  }

  #scheduleReconnect(attempt: number): void {
    if (this.#closed) return
    const backoff = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 5))
    const jitter = randomBytes(2).readUInt16BE(0) / 65_535
    this.#reconnectTimer = setTimeout(() => this.#dial(attempt + 1), backoff * (0.7 + 0.3 * jitter))
  }
}

export function webSocketTransportFactory(url: string): TransportFactory {
  return (onMessage, onStatusChange) => {
    const transport = new WebSocketTransport(url)
    transport.onMessage(onMessage)
    transport.onStatusChange(onStatusChange)
    transport.start()
    return transport
  }
}
