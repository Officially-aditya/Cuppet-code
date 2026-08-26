import { randomBytes } from 'node:crypto'
import { chmod, mkdir, unlink } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'

import type { CuppetController } from '../controller.js'
import { ControlRouter } from './router.js'
import { PLATFORM_OPTIONS } from '../platforms.js'
import type { RuntimePaths } from '../runtime/paths.js'
import type { Platform } from '../types.js'

const MAX_LINE_BYTES = 256 * 1024

export type ControlAddress = {
  socket: string
  token: string
}

export type RemoteControlStatus = {
  running: boolean
  hostId?: string
  deviceName?: string
  invite?: {
    code: string
    expiresAt: number
    url?: string
  }
}

export type RemoteControlManager = {
  start(): Promise<RemoteControlStatus>
  stop(): RemoteControlStatus
  status(): RemoteControlStatus
}

type ControlServerOptions = {
  remote?: RemoteControlManager
}

export class CuppetControlServer {
  readonly #controller: CuppetController
  readonly #router: ControlRouter
  readonly #server: Server
  readonly #address: ControlAddress
  readonly #remote: RemoteControlManager | undefined

  private constructor(
    controller: CuppetController,
    server: Server,
    address: ControlAddress,
    remote?: RemoteControlManager,
  ) {
    this.#controller = controller
    this.#router = new ControlRouter(controller)
    this.#server = server
    this.#address = address
    this.#remote = remote
  }

  static async start(
    controller: CuppetController,
    paths: RuntimePaths,
    address = createControlAddress(paths),
    options: ControlServerOptions = {},
  ): Promise<CuppetControlServer> {
    const { socket } = address
    await mkdir(paths.runtime, { recursive: true, mode: 0o700 })
    await unlink(socket).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    const server = createServer()
    const instance = new CuppetControlServer(controller, server, address, options.remote)
    server.on('connection', (connection) => instance.#handle(connection))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socket, () => {
        server.off('error', reject)
        resolve()
      })
    })
    await chmod(socket, 0o600)
    return instance
  }

  get address(): ControlAddress { return { ...this.#address } }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
    await unlink(this.#address.socket).catch(() => undefined)
  }

  #handle(socket: Socket): void {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) {
        socket.destroy(new Error('control request exceeds frame limit'))
        return
      }
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf('\n')
        void this.#dispatch(socket, line)
      }
    })
  }

  async #dispatch(socket: Socket, line: string): Promise<void> {
    let request: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('request must be an object')
      request = parsed as Record<string, unknown>
    } catch (error) {
      this.#write(socket, { ok: false, error: (error as Error).message })
      return
    }
    if (request.token !== this.#address.token) {
      this.#write(socket, { ok: false, error: 'unauthorized' })
      socket.end()
      return
    }
    const method = typeof request.method === 'string' ? request.method : ''
    const params = request.params && typeof request.params === 'object' ? request.params as Record<string, unknown> : {}
    try {
      const result = await this.#call(method, params)
      this.#write(socket, { ok: true, result })
    } catch (error) {
      this.#write(socket, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  async #call(method: string, params: Record<string, unknown>): Promise<unknown> {
    // The router owns authorization + dispatch for everything a remote
    // transport may also call, so local and remote surfaces stay in lockstep.
    if (ControlRouter.handles(method)) {
      return this.#router.execute({ kind: 'local' }, method, params)
    }
    switch (method) {
      case 'status': return this.#controller.status()
      case 'doctor': return this.#controller.doctor()
      case 'platform.list': return platformState(this.#controller)
      case 'platform.select': {
        const platform = platformParam(params.platform)
        await this.#controller.selectPlatform(platform)
        return platformState(this.#controller)
      }
      case 'background.status': return this.#controller.snapshot.background ?? { paused: true }
      case 'background.set': {
        if (typeof params.paused !== 'boolean') throw new Error('background.set requires paused')
        await this.#controller.setBackgroundPaused(params.paused)
        return this.#controller.snapshot.background ?? { paused: params.paused }
      }
      case 'auto.status': return { enabled: this.#controller.autoApprovalEnabled }
      case 'auto.set': {
        if (typeof params.enabled !== 'boolean') throw new Error('auto.set requires enabled')
        return this.#controller.setAutoApprovalEnabled(params.enabled, optionalStringParam(params, 'sessionID'))
      }
      case 'orchestrator.status': return { enabled: this.#controller.orchestratorEnabled }
      case 'orchestrator.set': {
        if (typeof params.enabled !== 'boolean') throw new Error('orchestrator.set requires enabled')
        await this.#controller.setOrchestratorEnabled(params.enabled)
        return { enabled: this.#controller.orchestratorEnabled }
      }
      case 'memory.remember':
        return this.#controller.remember(stringParam(params, 'key'), stringParam(params, 'value'), memoryScopeParam(params.scope))
      case 'memory.forget': return this.#controller.forget(stringParam(params, 'key'))
      case 'memory.clear': return this.#controller.clearMemory(scopeParam(params.scope))
      case 'plan.toggle':
        return {
          enabled: this.#controller.syncNativeAgent(
            this.#controller.snapshot.planMode ? 'build' : 'plan',
            optionalStringParam(params, 'sessionID'),
          ),
          agent: this.#controller.snapshot.planMode ? 'plan' : 'build',
        }
      case 'remote.status': return this.#remote?.status() ?? { running: false }
      case 'remote.start': {
        if (!this.#remote) throw new Error('remote control is unavailable')
        return this.#remote.start()
      }
      case 'remote.stop': {
        if (!this.#remote) throw new Error('remote control is unavailable')
        return this.#remote.stop()
      }
      case 'session.adopt': return this.#controller.adoptSession(stringParam(params, 'sessionID'))
      case 'session.list': return this.#controller.listSessions()
      default: throw new Error(`unknown control method ${method}`)
    }
  }

  #write(socket: Socket, value: unknown): void {
    socket.write(`${JSON.stringify(value)}\n`)
  }
}

function platformState(controller: CuppetController): Record<string, unknown> {
  return {
    selected: controller.snapshot.platform,
    options: PLATFORM_OPTIONS.map((option) => ({
      ...option,
      models: controller.modelsForPlatform(option.value, 'primary').length,
      connected: controller.integrationsForPlatform(option.value).some((integration) => integration.connections.length > 0),
    })),
  }
}

export function createControlAddress(paths: RuntimePaths): ControlAddress {
  return { socket: `${paths.runtime}/control.sock`, token: randomBytes(32).toString('base64url') }
}

function stringParam(params: Record<string, unknown>, name: string): string {
  const value = params[name]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`)
  return value.trim()
}

function optionalStringParam(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function scopeParam(value: unknown): 'session' | 'project' | 'global' {
  if (value === 'session' || value === 'project' || value === 'global') return value
  throw new Error('scope must be session, project, or global')
}

function memoryScopeParam(value: unknown): 'project' | 'global' {
  if (value === 'project' || value === 'global') return value
  throw new Error('memory remember scope must be project or global')
}

function platformParam(value: unknown): Platform {
  if (value === 'anthropic' || value === 'openai' || value === 'google' || value === 'opencode' || value === 'vertex') {
    return value
  }
  throw new Error('platform must be anthropic, openai, google, opencode, or vertex')
}
