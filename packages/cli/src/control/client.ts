import { createConnection, type Socket } from 'node:net'

const MAX_LINE_BYTES = 256 * 1024

export class CuppetControlClient {
  readonly #socketPath: string
  readonly #token: string

  constructor(socketPath: string, token: string) {
    this.#socketPath = socketPath
    this.#token = token
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const socket = await connect(this.#socketPath)
    try {
      socket.write(`${JSON.stringify({ token: this.#token, method, params })}\n`)
      const response = await readLine(socket)
      if (!response.ok) throw new Error(response.error ?? 'Cuppet control request failed')
      return response.result as T
    } finally {
      socket.destroy()
    }
  }
}

type Response = { ok: boolean; result?: unknown; error?: string }

function connect(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

function readLine(socket: Socket): Promise<Response> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        cleanup()
        reject(new Error('control response exceeds frame limit'))
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      cleanup()
      try { resolve(JSON.parse(buffer.slice(0, newline)) as Response) } catch (error) { reject(error) }
    }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const onClose = () => { cleanup(); reject(new Error('control socket closed before response')) }
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}
