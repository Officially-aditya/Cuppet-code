import { randomUUID } from 'node:crypto'
import type { CuppetController } from '../controller.js'
import { ControlRouter, type ControlActor } from '../control/router.js'
import {
  encodeFrame,
  parseCommandFrame,
  publicEventFor,
  scopeForCommand,
  PROTOCOL_VERSION,
  type EventFrame,
  type ResultFrame,
} from './protocol.js'
import type { RemoteTransport } from './connection.js'

export type BridgeOptions = {
  controller: CuppetController
  hostId: string
  transport: RemoteTransport
  /** Authenticates a device credential pair; undefined disables all commands. */
  authenticateDevice?: (deviceID: string, secret: string) => Promise<{
    scopes: readonly string[]
    name?: string
    /** JWT expiry in Unix seconds; local paired credentials omit this. */
    expiresAt?: number
  } | undefined>
  /** Redeems a single-use pairing invite for new device credentials. */
  claimPairingInvite?: (code: string, deviceName: string) => Promise<{
    deviceId: string
    secret: string
    scopes: readonly string[]
    name?: string
  } | undefined>
  /** Extra frames published right after (re)connect — attach snapshot etc. */
  buildAttachSnapshot?: () => Promise<Record<string, unknown>>
  write?: (line: string) => void
}

const DEDUPE_CAPACITY = 512
/** Bump when a protocol change requires clients to update. */
export const MINIMUM_CLIENT_VERSION = 1

/**
 * RemoteBridge: publishes semantic controller events outbound and executes
 * authorized remote commands against the shared ControlRouter. The relay and
 * the phone are untrusted transports — every command is scope-checked here,
 * duplicate command ids are executed exactly once, and reconnecting clients
 * receive a full snapshot plus buffered events before live traffic resumes.
 */
export class RemoteBridge {
  readonly #controller: CuppetController
  readonly #router: ControlRouter
  readonly #transport: RemoteTransport
  readonly #hostId: string
  readonly #authenticateDevice: BridgeOptions['authenticateDevice']
  readonly #claimPairingInvite: BridgeOptions['claimPairingInvite']
  readonly #buildAttachSnapshot: BridgeOptions['buildAttachSnapshot']
  readonly #write: ((line: string) => void) | undefined
  #seq = 0
  /** Changes when a new host process takes authority for this host id. */
  readonly #connectionId = randomUUID()
  #unsubscribers: Array<() => void> = []
  #seenCommandIds = new Map<string, true>()
  #offlineBuffer: EventFrame[] = []
  #devices = new Map<string, { scopes: readonly string[]; name?: string; expiresAt?: number }>()
  #deviceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  #started = false

  constructor(options: BridgeOptions) {
    this.#controller = options.controller
    this.#router = new ControlRouter(options.controller)
    this.#transport = options.transport
    this.#hostId = options.hostId
    this.#authenticateDevice = options.authenticateDevice
    this.#claimPairingInvite = options.claimPairingInvite
    this.#buildAttachSnapshot = options.buildAttachSnapshot
    this.#write = options.write
  }

  #output(line: string): void {
    try {
      this.#write?.(line)
    } catch {}
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    // Transports that dial lazily (WebSocketTransport) must be told to start.
    this.#transport.start?.()
    let mode: 'idle' | 'thinking' | 'replying' | 'tool' = 'idle'

    this.#unsubscribers.push(
      this.#controller.onAgentEvent((event) => {
        const publicEvent = publicEventFor(event as unknown as Record<string, unknown>)
        if (!publicEvent) return
        this.#publish(publicEvent.type, publicEvent.payload, sessionIdOf(event))

        switch (event.type) {
          case 'reasoning-delta': {
            if (mode !== 'thinking') {
              if (mode === 'replying') this.#output('\n')
              mode = 'thinking'
              this.#output('\x1b[2;35mThinking: \x1b[0m\x1b[2m')
            }
            if (event.text) {
              this.#output(event.text)
            }
            break
          }
          case 'text-delta': {
            if (mode !== 'replying') {
              if (mode === 'thinking') this.#output('\x1b[0m\n')
              mode = 'replying'
              this.#output('\x1b[1;32mResponse:\x1b[0m\n')
            }
            if (event.text) {
              this.#output(event.text)
            }
            break
          }
          case 'tool-start': {
            if (mode === 'thinking') this.#output('\x1b[0m\n')
            if (mode === 'replying') this.#output('\n')
            mode = 'tool'
            const toolName = event.name ?? 'tool'
            const inputSummary = formatToolInput(event.name, event.input)
            this.#output(`\x1b[1;34mTool:\x1b[0m \x1b[36m${toolName}\x1b[0m${inputSummary ? ` \x1b[2m(${inputSummary})\x1b[0m` : ''}\n`)
            break
          }
          case 'tool-progress': {
            if (event.message) {
              this.#output(`  \x1b[2m↳ ${event.message}\x1b[0m\n`)
            }
            break
          }
          case 'tool-end': {
            const statusTag = event.success ? '\x1b[32m[done]\x1b[0m' : '\x1b[31m[failed]\x1b[0m'
            const toolName = event.name ?? 'tool'
            this.#output(`  ${statusTag} \x1b[2m${toolName} ${event.success ? 'completed' : 'failed'}\x1b[0m\n`)
            break
          }
          case 'diff': {
            this.#output(`  \x1b[33mFile modifications applied\x1b[0m\n`)
            break
          }
          case 'permission': {
            if (mode === 'thinking') this.#output('\x1b[0m\n')
            if (mode === 'replying') this.#output('\n')
            mode = 'idle'
            const action = (event.request as Record<string, unknown>)?.action ?? (event.request as Record<string, unknown>)?.permission ?? 'action'
            this.#output(`\x1b[1;33mPermission requested:\x1b[0m ${action} (waiting for mobile approval…)\n`)
            break
          }
          case 'permission-resolved': {
            this.#output(`  \x1b[32mPermission resolved:\x1b[0m ${event.reply ?? 'resolved'}\n`)
            break
          }
          case 'question': {
            if (mode === 'thinking') this.#output('\x1b[0m\n')
            if (mode === 'replying') this.#output('\n')
            mode = 'idle'
            this.#output(`\x1b[1;35mQuestion sent to user on mobile\x1b[0m\n`)
            break
          }
          case 'error': {
            if (mode === 'thinking') this.#output('\x1b[0m\n')
            if (mode === 'replying') this.#output('\n')
            mode = 'idle'
            this.#output(`\x1b[1;31mError:\x1b[0m ${event.message}\n`)
            break
          }
          case 'idle': {
            if (mode === 'thinking') this.#output('\x1b[0m\n')
            if (mode === 'replying') this.#output('\n')
            mode = 'idle'
            this.#output(`\x1b[1;32mTurn complete. Ready.\x1b[0m\n\n`)
            break
          }
        }
      }),
      this.#controller.onChange((snapshot) => {
        this.#publish('host.snapshot', snapshot)
      }),
    )
    this.#transport.onMessage((data) => void this.#handleIncoming(data).catch(() => this.#replyError('', 'malformed frame')))
    this.#transport.onStatusChange((connected) => {
      if (!connected) {
        // A relay reconnect is a new transport authority. Every device must
        // perform the hello handshake again before it can issue commands.
        this.#clearDevices()
        return
      }
      void this.#onConnected()
    })
  }

  stop(): void {
    if (!this.#started) return
    this.#started = false
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe()
    this.#clearDevices()
    this.#offlineBuffer.length = 0
    try {
      this.#transport.close()
    } catch {}
  }

  async #onConnected(): Promise<void> {
    // Snapshot first, then any events buffered while offline: a reconnecting
    // client never depends on having witnessed earlier live frames.
    try {
      const payload = this.#buildAttachSnapshot
        ? await this.#buildAttachSnapshot()
        : {
            snapshot: await this.#controller.status(),
            permissions: await this.#controller.listPendingPermissions().catch(() => []),
            questions: await this.#controller.listPendingQuestions().catch(() => []),
          }
      this.#sendRaw(encodeFrame({
        version: PROTOCOL_VERSION,
        // Attach is a control snapshot, not a stream event. Keeping it at
        // seq=0 lets buffered events retain their original sequence numbers.
        seq: 0,
        hostId: this.#hostId,
        ts: Date.now(),
        type: 'host.attach',
        payload: {
          ...payload,
          connectionId: this.#connectionId,
          protocolVersion: PROTOCOL_VERSION,
          minimumClientVersion: MINIMUM_CLIENT_VERSION,
        },
      }))
    } catch {}
    for (const frame of this.#offlineBuffer.splice(0)) {
      this.#sendRaw(encodeFrame(frame))
    }
  }

  publish(type: string, payload: unknown): void {
    this.#publish(type, payload)
  }

  #publish(type: string, payload: unknown, sessionId?: string): void {
    const frame: EventFrame = {
      version: PROTOCOL_VERSION,
      seq: ++this.#seq,
      hostId: this.#hostId,
      ts: Date.now(),
      type,
      ...(sessionId ? { sessionId } : {}),
      ...(payload !== undefined ? { payload } : {}),
    }
    if (!this.#transport.connected) {
      this.#offlineBuffer.push(frame)
      if (this.#offlineBuffer.length > 256) this.#offlineBuffer.shift()
      return
    }
    this.#sendRaw(encodeFrame(frame))
  }

  #sendRaw(data: string): void {
    try {
      this.#transport.send(data)
    } catch {}
  }

  async #handleIncoming(data: string): Promise<void> {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(data) as Record<string, unknown>
    } catch {
      return this.#replyError('', 'malformed frame')
    }
    const kind = typeof parsed.type === 'string' ? parsed.type : ''
    if (kind === 'ping') return
    const requestDeviceId =
      typeof parsed.deviceId === 'string' && parsed.deviceId
        ? parsed.deviceId
        : String(
            (parsed.payload as Record<string, unknown> | undefined)?.deviceId ?? '',
          )
    if (kind === 'device.hello') return this.#handleDeviceHello(parsed, requestDeviceId)
    if (kind === 'device.pair') return this.#handleDevicePair(parsed, requestDeviceId)
    const device = requestDeviceId ? this.#devices.get(requestDeviceId) : undefined
    if (!device) {
      // Answer with the sender's own id when present so clients fail fast
      // instead of timing out; bare rejections still use client.reject.
      const commandId = typeof parsed.id === 'string' ? parsed.id : ''
      this.#rejectDevice(requestDeviceId, 'not authenticated')
      if (!commandId) return
      return this.#resultError(commandId, 'not authenticated', requestDeviceId)
    }
    let envelope
    try {
      envelope = parseCommandFrame(data)
    } catch (error) {
      // Answer the sender even for invalid frames so clients never hang.
      const fallbackId = typeof parsed.id === 'string' ? parsed.id : 'unknown'
      return this.#resultError(fallbackId, `malformed command: ${(error as Error).message}`, requestDeviceId)
    }
    // Idempotency: replays after network retries must not double-execute
    // destructive commands like undo or submit.
    const dedupeKey = `${requestDeviceId}:${envelope.id}`
    if (this.#seenCommandIds.has(dedupeKey)) {
      return this.#sendRaw(encodeFrame({
        version: PROTOCOL_VERSION,
        replyTo: envelope.id,
        ok: true,
        result: { duplicate: true },
        ...(requestDeviceId ? { deviceId: requestDeviceId } : {}),
      } satisfies ResultFrame))
    }
    this.#remember(dedupeKey)
    const requiredScope = scopeForCommand(envelope.type)
    if (!requiredScope || !device.scopes.includes(requiredScope)) {
      return this.#resultError(
        envelope.id,
        `missing scope '${requiredScope ?? 'none'}' for ${envelope.type}`,
        requestDeviceId,
      )
    }
    const actor: ControlActor = {
      kind: 'remote',
      deviceID: requestDeviceId,
      ...(device.name ? { deviceName: device.name } : {}),
      scopes: device.scopes,
    }
    if (envelope.type === 'session.submit') {
      const prompt = String((envelope.payload as Record<string, unknown> | undefined)?.prompt ?? '')
      this.#output(`\n\x1b[1;36m╭─ [Prompt from ${device.name ?? 'Mobile'}] ────────────────────\x1b[0m\n\x1b[1m│ ${prompt.split('\n').join('\n│ ')}\x1b[0m\n\x1b[1;36m╰───────────────────────────────────────────────\x1b[0m\n\n`)
    } else if (envelope.type === 'session.steer') {
      const instr = String((envelope.payload as Record<string, unknown> | undefined)?.instruction ?? '')
      this.#output(`\n\x1b[1;33m╭─ [Steer from ${device.name ?? 'Mobile'}] ─────────────────────\x1b[0m\n\x1b[1m│ ${instr.split('\n').join('\n│ ')}\x1b[0m\n\x1b[1;33m╰───────────────────────────────────────────────\x1b[0m\n\n`)
    } else if (envelope.type !== 'host.get' && envelope.type !== 'session.snapshot' && envelope.type !== 'session.list' && envelope.type !== 'model.list' && envelope.type !== 'platform.list') {
      this.#output(`\x1b[2m  [remote] ${device.name ?? 'device'} > ${envelope.type}\x1b[0m\n`)
    }
    try {
      const result = await this.#router.execute(actor, envelope.type, (envelope.payload as Record<string, unknown>) ?? {})
      this.#sendRaw(encodeFrame({
        version: PROTOCOL_VERSION,
        replyTo: envelope.id,
        ok: true,
        ...(result !== undefined ? { result } : {}),
        ...(requestDeviceId ? { deviceId: requestDeviceId } : {}),
      } satisfies ResultFrame))
    } catch (error) {
      this.#output(`  [remote] ${device.name ?? 'device'} error: ${(error as Error).message}\n`)
      this.#resultError(envelope.id, error instanceof Error ? error.message : String(error), requestDeviceId)
    }
  }

  async #handleDevicePair(parsed: Record<string, unknown>, deviceId: string): Promise<void> {
    const fail = (message: string): void => {
      this.#sendRaw(encodeFrame({
        version: PROTOCOL_VERSION,
        replyTo: 'device-pair',
        ok: false,
        error: message,
        ...(deviceId ? { deviceId } : {}),
      } satisfies ResultFrame & { deviceId?: string }))
    }
    if (!this.#claimPairingInvite) return fail('pairing unavailable')
    const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload as Record<string, unknown> : {}
    const code = typeof payload.code === 'string' ? payload.code.trim().toUpperCase() : ''
    const name = typeof payload.name === 'string' ? payload.name : ''
    // The claim itself validates existence, single use, and expiry.
    const claimed = code ? await this.#claimPairingInvite(code, name).catch(() => undefined) : undefined
    if (!claimed) return fail('invalid or expired pairing code')
    this.#sendRaw(encodeFrame({
      version: PROTOCOL_VERSION,
      seq: 0,
      hostId: this.#hostId,
      ts: Date.now(),
      type: 'device.paired',
      payload: { deviceId: claimed.deviceId },
      ...(deviceId ? { deviceId } : {}),
    }))
    this.#sendRaw(encodeFrame({
      version: PROTOCOL_VERSION,
      replyTo: 'device-pair',
      ok: true,
      result: { deviceId: claimed.deviceId, secret: claimed.secret, scopes: [...claimed.scopes] },
      ...(deviceId ? { deviceId } : {}),
    } satisfies ResultFrame & { deviceId?: string }))
  }

  async #handleDeviceHello(parsed: Record<string, unknown>, deviceId: string): Promise<void> {
    const secret = String((parsed.payload as Record<string, unknown> | undefined)?.secret ?? '')
    if (!this.#authenticateDevice || !deviceId || !secret) {
      this.#clearDevice(deviceId)
      return this.#rejectDevice(deviceId, 'authentication unavailable')
    }
    const device = await this.#authenticateDevice(deviceId, secret)
    if (!device) {
      this.#clearDevice(deviceId)
      return this.#rejectDevice(deviceId, 'unknown device credentials')
    }
    this.#clearDevice(deviceId)
    this.#devices.set(deviceId, {
      scopes: device.scopes,
      ...(device.name ? { name: device.name } : {}),
      ...(device.expiresAt !== undefined ? { expiresAt: device.expiresAt } : {}),
    })
    this.#scheduleDeviceExpiry(deviceId, device.expiresAt)
    this.#output(`  [remote] device connected: ${device.name ?? 'device'} [${deviceId}]\n`)
    // Tell the relay to start delivering live traffic to this device, then
    // confirm the credential check to the device itself.
    this.#sendRaw(encodeFrame({ version: PROTOCOL_VERSION, seq: 0, hostId: this.#hostId, ts: Date.now(), type: 'client.accept', payload: {}, deviceId }))
    this.#sendRaw(encodeFrame({
      version: PROTOCOL_VERSION,
      replyTo: 'device-hello',
      ok: true,
      result: { deviceId, name: device.name ?? '', scopes: [...device.scopes] },
      deviceId,
    } satisfies ResultFrame & { deviceId: string }))
  }

  #rejectDevice(deviceId: string, message: string): void {
    if (deviceId) {
      this.#sendRaw(encodeFrame({ version: PROTOCOL_VERSION, seq: 0, hostId: this.#hostId, ts: Date.now(), type: 'client.reject', payload: {}, deviceId }))
    }
    this.#sendRaw(encodeFrame({ version: PROTOCOL_VERSION, replyTo: 'device-hello', ok: false, error: message, ...(deviceId ? { deviceId } : {}) } satisfies ResultFrame & { deviceId?: string }))
  }

  #scheduleDeviceExpiry(deviceId: string, expiresAt?: number): void {
    if (expiresAt === undefined || !Number.isFinite(expiresAt)) return
    const delay = Math.max(0, expiresAt * 1000 - Date.now())
    const timer = setTimeout(() => {
      const device = this.#devices.get(deviceId)
      if (!device || device.expiresAt !== expiresAt) return
      this.#devices.delete(deviceId)
      this.#deviceTimers.delete(deviceId)
      this.#rejectDevice(deviceId, 'remote credential expired')
    }, delay)
    timer.unref?.()
    this.#deviceTimers.set(deviceId, timer)
  }

  #clearDevice(deviceId: string): void {
    const timer = this.#deviceTimers.get(deviceId)
    if (timer) clearTimeout(timer)
    this.#deviceTimers.delete(deviceId)
    this.#devices.delete(deviceId)
  }

  #clearDevices(): void {
    for (const timer of this.#deviceTimers.values()) clearTimeout(timer)
    this.#deviceTimers.clear()
    this.#devices.clear()
  }

  #remember(id: string): void {
    this.#seenCommandIds.set(id, true)
    if (this.#seenCommandIds.size > DEDUPE_CAPACITY) {
      const oldest = this.#seenCommandIds.keys().next().value
      if (oldest !== undefined) this.#seenCommandIds.delete(oldest)
    }
  }

  #resultError(replyTo: string, message: string, deviceId?: string): void {
    this.#sendRaw(encodeFrame({
      version: PROTOCOL_VERSION,
      replyTo,
      ok: false,
      error: message,
      ...(deviceId ? { deviceId } : {}),
    } satisfies ResultFrame))
  }

  #replyError(_replyTo: string, message: string): void {
    // Malformed frames may lack a usable id; emit a diagnostic-only event.
    this.#publish('bridge.error', { message }, undefined)
  }
}

function sessionIdOf(event: unknown): string | undefined {
  const id = (event as { sessionID?: unknown }).sessionID
  return typeof id === 'string' ? id : undefined
}

function formatToolInput(name?: string, input?: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  if (typeof record.command === 'string') return `"${record.command}"`
  if (typeof record.path === 'string') return record.path
  if (typeof record.pattern === 'string') return `"${record.pattern}"`
  if (typeof record.query === 'string') return `"${record.query}"`
  if (typeof record.file === 'string') return record.file
  if (typeof record.url === 'string') return record.url
  if (typeof record.prompt === 'string') return `"${record.prompt.slice(0, 60)}"`
  const firstVal = Object.values(record).find((v) => typeof v === 'string')
  if (typeof firstVal === 'string' && firstVal.length < 80) return `"${firstVal}"`
  return ''
}
