import { z } from 'zod'

/**
 * Public remote-control protocol (v1). Deliberately independent from Cuppet's
 * internal TypeScript types: AgentEvent maps into these semantic events at the
 * bridge boundary so the wire format stays stable across refactors and can
 * gain payload-level end-to-end encryption without breaking transports.
 */

export const PROTOCOL_VERSION = 1

/** Maximum serialized frame size accepted from any remote peer. */
export const MAX_FRAME_BYTES = 512 * 1024

export const REMOTE_SCOPES = ['session.read', 'session.write', 'permission.write', 'question.write', 'model.write'] as const
export type RemoteScope = (typeof REMOTE_SCOPES)[number]

export const DEFAULT_DEVICE_SCOPES: RemoteScope[] = [
  'session.read',
  'session.write',
  'permission.write',
  'question.write',
]
export const VIEWER_DEVICE_SCOPES: RemoteScope[] = ['session.read']

const envelopeBase = {
  version: z.literal(PROTOCOL_VERSION),
  hostId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(256).optional(),
  ts: z.number().int().nonnegative(),
}

/**
 * Commands travel device → host. The WebSocket room already binds them to a
 * single host, so clients are not required to echo hostId back.
 */
export const commandEnvelopeSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  hostId: z.string().min(1).max(128).optional(),
  sessionId: z.string().min(1).max(256).optional(),
  ts: z.number().int().nonnegative(),
  id: z.string().min(1).max(128),
  type: z.string().min(1).max(64),
  payload: z.unknown().optional(),
})

export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>

export const resultFrameSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  replyTo: z.string().min(1),
  ok: z.literal(true),
  result: z.unknown().optional(),
})
export const resultErrorFrameSchema = z.object({
  version: z.literal(PROTOCOL_VERSION),
  replyTo: z.string().min(1),
  ok: z.literal(false),
  error: z.string(),
})

export type ResultFrame =
  | { version: number; replyTo: string; ok: true; result?: unknown }
  | { version: number; replyTo: string; ok: false; error: string }

export const eventFrameSchema = z.object({
  ...envelopeBase,
  /** Host-assigned monotonic sequence for ordering + gap detection. */
  seq: z.number().int().nonnegative(),
  type: z.string().min(1).max(64),
  payload: z.unknown().optional(),
})

export type EventFrame = z.infer<typeof eventFrameSchema>

/**
 * Scope required per remotely callable command. Mirrors ControlRouter's table;
 * the bridge re-checks here because the router trusts its caller to gate.
 */
export const COMMAND_SCOPES: Record<string, RemoteScope | null> = {
  'host.get': 'session.read',
  'workspace.list': 'session.read',
  'session.list': 'session.read',
  'session.snapshot': 'session.read',
  'session.messages': 'session.read',
  'permission.list': 'session.read',
  'question.list': 'session.read',
  'model.list': 'session.read',
  'agent.mode.get': 'session.read',
  'workspace.attach': 'session.write',
  'session.new': 'session.write',
  'session.resume': 'session.write',
  'session.submit': 'session.write',
  'session.steer': 'session.write',
  'session.abort': 'session.write',
  'session.undo': 'session.write',
  'session.compact': 'session.write',
  'plan.set': 'session.write',
  'permission.reply': 'permission.write',
  'question.reply': 'question.write',
  'question.reject': 'question.write',
  'model.select': 'model.write',
}

export function scopeForCommand(type: string): RemoteScope | null {
  return COMMAND_SCOPES[type] ?? null
}

export function encodeFrame(value: unknown): string {
  const data = JSON.stringify(value)
  if (Buffer.byteLength(data, 'utf8') > MAX_FRAME_BYTES) {
    throw new Error(`frame exceeds ${MAX_FRAME_BYTES} bytes`)
  }
  return data
}

export function parseCommandFrame(data: string): CommandEnvelope {
  if (Buffer.byteLength(data, 'utf8') > MAX_FRAME_BYTES) throw new Error('frame too large')
  const parsed = commandEnvelopeSchema.parse(JSON.parse(data))
  if (!scopeForCommand(parsed.type)) throw new Error(`unsupported command type: ${parsed.type}`)
  return parsed
}

/** Map an internal AgentEvent into its public semantic event, dropping internals. */
export function publicEventFor(agentEvent: Record<string, unknown>): { type: string; payload: unknown } | undefined {
  const type = typeof agentEvent.type === 'string' ? agentEvent.type : ''
  switch (type) {
    case 'text-delta':
      return { type: 'assistant.text.delta', payload: { text: agentEvent.text } }
    case 'reasoning-delta':
      return { type: 'assistant.reasoning.delta', payload: { text: agentEvent.text } }
    case 'tool-start':
      return { type: 'tool.started', payload: { callID: agentEvent.callID, name: agentEvent.name, input: agentEvent.input ?? null } }
    case 'tool-progress':
      return { type: 'tool.progress', payload: { callID: agentEvent.callID, message: agentEvent.message } }
    case 'tool-end':
      return {
        type: 'tool.completed',
        payload: {
          callID: agentEvent.callID,
          success: agentEvent.success === true,
          name: agentEvent.name ?? null,
          ...(typeof agentEvent.diff === 'string' ? { diff: agentEvent.diff } : {}),
        },
      }
    case 'diff':
      return { type: 'diff.updated', payload: { diff: agentEvent.diff } }
    case 'permission':
      return { type: 'permission.requested', payload: { request: agentEvent.request } }
    case 'permission-resolved':
      return {
        type: 'permission.resolved',
        payload: { requestID: agentEvent.requestID, ...(typeof agentEvent.reply === 'string' ? { reply: agentEvent.reply } : {}) },
      }
    case 'question':
      return { type: 'question.requested', payload: { request: agentEvent.request } }
    case 'question-resolved':
      return {
        type: 'question.resolved',
        payload: { requestID: agentEvent.requestID, accepted: agentEvent.accepted === true },
      }
    case 'idle':
      return { type: 'session.idle', payload: {} }
    case 'session':
      return { type: 'session.updated', payload: { sessionID: agentEvent.sessionID, agent: agentEvent.agent ?? null } }
    case 'usage':
      return { type: 'usage.updated', payload: { usage: agentEvent.usage, cost: agentEvent.cost } }
    case 'compaction':
      return { type: 'compaction', payload: { phase: agentEvent.phase } }
    case 'error':
      return { type: 'agent.error', payload: { message: agentEvent.message } }
    case 'step-limit':
      return { type: 'step.limit', payload: { steps: agentEvent.steps } }
    default:
      // Internal-only events (tst-notification etc.) never cross the wire.
      return undefined
  }
}
