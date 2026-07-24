import { createConnection, type Socket } from 'node:net'

const MAX_FRAME_BYTES = 16 * 1024 * 1024

type RpcResponse<T> = {
  jsonrpc: '2.0'
  id: number
  result?: T
  error?: { code: number; message: string }
}

export class TstToolClient {
  readonly #socketPath: string
  readonly #token: string
  #nextID = 1

  constructor(socketPath: string, token: string) {
    this.#socketPath = socketPath
    this.#token = token
  }

  async query(sessionID: string, query: string, limit: number): Promise<unknown> {
    return this.#request('memory.query', {
      session_id: sessionID,
      query,
      limit: Math.min(Math.max(limit, 1), 40),
    })
  }

  async graphSearch(pattern: string, prefix?: string, limit = 40): Promise<unknown> {
    return this.#request('graph.search', {
      pattern,
      ...(prefix ? { prefix } : {}),
      limit: Math.min(Math.max(limit, 1), 128),
    })
  }

  async graphList(prefix?: string, limit = 100): Promise<unknown> {
    return this.#request('graph.list', {
      ...(prefix ? { prefix } : {}),
      limit: Math.min(Math.max(limit, 1), 512),
    })
  }

  async graphWorkspace(limit = 100): Promise<unknown> {
    return this.#request('graph.workspace', {
      limit: Math.min(Math.max(limit, 1), 512),
    })
  }

  async graphTrace(
    query: string,
    direction: 'callers' | 'callees' | 'both' = 'both',
    depth = 2,
    limit = 40,
  ): Promise<unknown> {
    return this.#request('graph.trace', {
      query,
      direction,
      depth: Math.min(Math.max(depth, 1), 4),
      limit: Math.min(Math.max(limit, 1), 128),
    })
  }

  async #request(method: string, params: unknown): Promise<unknown> {
    const socket = await connect(this.#socketPath)
    try {
      await this.#call(socket, 'initialize', { token: this.#token })
      return await this.#call(socket, method, params)
    } finally {
      socket.destroy()
    }
  }

  async #call(socket: Socket, method: string, params: unknown): Promise<unknown> {
    const id = this.#nextID++
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    if (body.length > MAX_FRAME_BYTES) throw new Error('TST request exceeds frame limit')
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(body.length)
    socket.write(Buffer.concat([header, body]))
    const response = await readFrame<RpcResponse<unknown>>(socket)
    if (response.id !== id) throw new Error('TST response ID mismatch')
    if (response.error) throw new Error(response.error.message)
    return response.result
  }
}

function connect(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

function readFrame<T>(socket: Socket): Promise<T> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0)
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk])
      if (buffered.length < 4) return
      const length = buffered.readUInt32BE(0)
      if (length === 0 || length > MAX_FRAME_BYTES) {
        cleanup()
        reject(new Error(`Invalid TST frame length ${length}`))
        return
      }
      if (buffered.length < length + 4) return
      cleanup()
      try {
        resolve(JSON.parse(buffered.subarray(4, 4 + length).toString('utf8')) as T)
      } catch (error) {
        reject(error)
      }
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onClose = () => {
      cleanup()
      reject(new Error('TST socket closed before a response arrived'))
    }
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
