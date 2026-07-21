import { EventEmitter } from 'node:events'
import { createConnection, type Socket } from 'node:net'
import { TST_PROTOCOL_VERSION } from '../constants.js'

const MAX_FRAME_BYTES = 16 * 1024 * 1024

type Pending = {
  resolve(value: unknown): void
  reject(error: Error): void
}

type RpcResponse = {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

export type TstNotification = {
  jsonrpc: '2.0'
  method: string
  params: unknown
}

export class TstClient extends EventEmitter {
  readonly #socket: Socket
  #nextID = 1
  #buffer = Buffer.alloc(0)
  #pending = new Map<number, Pending>()
  #closed = false

  private constructor(socket: Socket) {
    super()
    this.#socket = socket
    socket.on('data', (chunk: Buffer) => this.#consume(chunk))
    socket.on('error', (error) => this.#failAll(error))
    socket.on('close', () => this.#failAll(new Error('TST socket closed')))
  }

  static async connect(socketPath: string, token: string): Promise<TstClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = createConnection(socketPath)
      candidate.once('connect', () => resolve(candidate))
      candidate.once('error', reject)
    })
    const client = new TstClient(socket)
    const initialized = (await client.call('initialize', { token, notifications: true })) as { protocol?: string }
    if (initialized.protocol !== TST_PROTOCOL_VERSION) {
      client.destroy()
      throw new Error(
        `TST protocol mismatch: expected ${TST_PROTOCOL_VERSION}, received ${initialized.protocol ?? 'unknown'}`,
      )
    }
    return client
  }

  call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('TST client is closed'))
    const id = this.#nextID++
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    if (payload.length > MAX_FRAME_BYTES) return Promise.reject(new Error('TST request exceeds frame limit'))
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(payload.length)
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      })
      this.#socket.write(Buffer.concat([header, payload]), (error) => {
        if (!error) return
        this.#pending.delete(id)
        reject(error)
      })
    })
  }

  onNotification(listener: (notification: TstNotification) => void): () => void {
    this.on('notification', listener)
    return () => this.off('notification', listener)
  }

  destroy(): void {
    this.#closed = true
    this.#socket.destroy()
    this.#failAll(new Error('TST client closed'))
  }

  #consume(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0)
      if (length === 0 || length > MAX_FRAME_BYTES) {
        this.destroy()
        return
      }
      if (this.#buffer.length < length + 4) return
      const payload = this.#buffer.subarray(4, length + 4)
      this.#buffer = this.#buffer.subarray(length + 4)
      let response: RpcResponse | TstNotification
      try {
        response = JSON.parse(payload.toString('utf8')) as RpcResponse
      } catch {
        this.destroy()
        return
      }
      if ('method' in response) {
        this.emit('notification', response)
        continue
      }
      const pending = this.#pending.get(response.id)
      if (!pending) continue
      this.#pending.delete(response.id)
      if (response.error) pending.reject(new Error(response.error.message))
      else pending.resolve(response.result)
    }
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }
}
