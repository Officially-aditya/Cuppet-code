import { createConnection, type Socket } from 'node:net'

type ControlResponse = { ok: boolean; result?: unknown; error?: string }

export class CuppetControlClient {
  readonly #socketPath: string
  readonly #token: string

  constructor(socketPath = process.env.CUPPET_CONTROL_SOCKET ?? '', token = process.env.CUPPET_CONTROL_TOKEN ?? '') {
    if (!socketPath || !token) throw new Error('Cuppet control API is unavailable')
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

function connect(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

function readLine(socket: Socket): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      if (Buffer.byteLength(buffer) > 256 * 1024) {
        cleanup()
        reject(new Error('Cuppet control response exceeds frame limit'))
        return
      }
      const end = buffer.indexOf('\n')
      if (end < 0) return
      cleanup()
      try { resolve(JSON.parse(buffer.slice(0, end)) as ControlResponse) } catch (error) { reject(error) }
    }
    const onError = (error: Error) => { cleanup(); reject(error) }
    const onClose = () => { cleanup(); reject(new Error('Cuppet control socket closed')) }
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
