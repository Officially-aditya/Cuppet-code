import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CuppetController } from '../controller.js'
import { CUPPET_VERSION } from '../constants.js'
import { loadHostIdentityOrNull } from '../remote/identity.js'
import { PLATFORM_OPTIONS } from '../platforms.js'
import type { Platform } from '../types.js'

/**
 * Who is asking. The Unix control socket always acts locally with full
 * authority; remote transports act through a reduced scope set that was
 * granted at device-pairing time. Authorization happens per message here —
 * an authenticated transport never implies unrestricted access.
 */
export type ControlActor =
  | { kind: 'local' }
  | {
      kind: 'remote'
      deviceID: string
      deviceName?: string
      scopes: readonly string[]
    }

/** Coarse capability buckets a paired device can hold. */
export const CONTROL_SCOPES = ['session.read', 'session.write', 'permission.write', 'question.write', 'model.write'] as const
export type ControlScope = (typeof CONTROL_SCOPES)[number]

type Handler = (controller: CuppetController, params: Record<string, unknown>) => Promise<unknown>

const PROTOCOL_VERSION = 1
const PROCESS_STARTED_AT = Date.now()

/**
 * Single authorization + dispatch point shared by the local Unix control
 * server and (future) remote transports. Methods marked localOnly are never
 * exposed over any remote transport regardless of granted scopes.
 */
export class ControlRouter {
  readonly #controller: CuppetController

  constructor(controller: CuppetController) {
    this.#controller = controller
  }

  /** True when a method is part of the shared (remote-exposable) surface. */
  static handles(method: string): boolean {
    const entry = ROUTE_TABLE[method]
    return Boolean(entry && !entry.localOnly)
  }

  async execute(actor: ControlActor, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const entry = ROUTE_TABLE[method]
    if (!entry) throw new Error(`unknown control method: ${method}`)
    if (actor.kind !== 'local') {
      if (entry.localOnly) throw new Error(`method not permitted for remote actors: ${method}`)
      if (!entry.scope) throw new Error(`method has no remote scope: ${method}`)
      if (!actor.scopes.includes(entry.scope)) {
        throw new Error(`missing scope '${entry.scope}' for method: ${method}`)
      }
    }
    return entry.run(this.#controller, params)
  }
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key} is required`)
  return value
}

/**
 * The remote surface: watch → answer → approve → steer → abort → inspect.
 * Memory management, diagnostics, platform/model-provider wiring and other
 * host-internal controls stay local by design.
 */
const ROUTE_TABLE: Record<string, { scope?: ControlScope; localOnly?: boolean; run: Handler }> = {
  'session.list': { scope: 'session.read', run: (c) => c.listSessions() },
  // The remote contract needs the live controller snapshot shape (including
  // activeSession/running/models), not the richer local diagnostic payload.
  'session.snapshot': { scope: 'session.read', run: (c) => Promise.resolve(c.snapshot) },
  'session.messages': {
    scope: 'session.read',
    run: async (c, params) => c.sessionMessages(requireString(params, 'sessionID')),
  },
  'session.new': { scope: 'session.write', run: (c) => c.newSession() },
  'session.resume': { scope: 'session.write', run: async (c, params) => c.resume(requireString(params, 'sessionID')) },
  'session.submit': {
    scope: 'session.write',
    run: async (c, params) => {
      await c.submit(requireString(params, 'prompt'), params.delivery === 'steer' ? 'steer' : 'queue')
      return { submitted: true }
    },
  },
  'session.steer': {
    scope: 'session.write',
    run: async (c, params) => c.steer(requireString(params, 'instruction'), params.interrupt === true),
  },
  'session.abort': {
    scope: 'session.write',
    run: async (c) => {
      await c.abort()
      return { aborted: true }
    },
  },
  'session.undo': {
    scope: 'session.write',
    run: async (c) => {
      await c.undo()
      return { undone: true }
    },
  },
  'session.compact': {
    scope: 'session.write',
    run: async (c) => {
      await c.compact()
      return { compacted: true }
    },
  },
  'plan.set': {
    scope: 'session.write',
    run: async (c, params) => {
      const agent = stringParam(params, 'agent')
      if (agent !== 'plan' && agent !== 'build') throw new Error('plan.set agent must be plan or build')
      const enabled = c.syncNativeAgent(agent, optionalSession(params))
      return { enabled, agent }
    },
  },
  'permission.list': { scope: 'session.read', run: (c) => c.listPendingPermissions() },
  'permission.reply': {
    scope: 'permission.write',
    run: async (c, params) => {
      const request = permissionParam(params)
      await c.replyPermission(
        { id: request.id, sessionID: request.sessionID, action: request.action ?? '', resources: [] },
        replyValue(params),
        typeof params.message === 'string' ? params.message : undefined,
      )
      return { replied: true }
    },
  },
  'question.list': { scope: 'session.read', run: (c) => c.listPendingQuestions() },
  'question.reply': {
    scope: 'question.write',
    run: async (c, params) => {
      await c.replyQuestion(requireString(params, 'requestID'), questionAnswersParam(params))
      return { replied: true }
    },
  },
  'question.reject': {
    scope: 'question.write',
    run: async (c, params) => {
      await c.rejectQuestion(requireString(params, 'requestID'))
      return { rejected: true }
    },
  },
  'model.list': {
    scope: 'session.read',
    run: (c) => {
      const platformModels = c.modelsForPlatform(undefined, 'primary')
      return Promise.resolve(platformModels.length > 0 ? platformModels : c.snapshot.models)
    },
  },
  'model.select': {
    scope: 'model.write',
    run: async (c, params) => {
      const modelID = requireString(params, 'modelID')
      let providerID = typeof params.providerID === 'string' && params.providerID.length > 0 ? params.providerID : undefined
      if (!providerID) {
        const found = c.snapshot.models.find((m) => m.id === modelID || m.name === modelID)
        providerID = found?.providerID
      }
      if (!providerID) {
        const platformModels = c.modelsForPlatform(undefined, 'primary')
        const found = platformModels.find((m) => m.id === modelID || m.name === modelID)
        providerID = found?.providerID
      }
      if (!providerID) {
        providerID = modelID.includes('/') ? modelID.split('/')[0] : (c.snapshot.platform ?? 'opencode')
      }
      await c.selectModel(params.role === 'secondary' ? 'secondary' : 'primary', {
        providerID,
        modelID: modelID.includes('/') ? modelID.split('/')[1] : modelID,
        ...(typeof params.variant === 'string' ? { variant: params.variant } : {}),
      })
      return { selected: true, providerID, modelID }
    },
  },

  /**
   * Mobile contract (docs/remote-protocol.md): host identity + BYOK provider
   * readiness in one call so Android can render onboarding without guessing.
   */
  'host.get': {
    scope: 'session.read',
    run: async (c) => {
      const identity =
        (await loadHostIdentityOrNull(join(homedir(), '.cuppet', 'v2', 'remote'))) ?? undefined
      const provider = c.providerStatus() as Record<string, unknown>
      return {
        hostId: identity?.hostId ?? null,
        name: identity?.deviceName ?? null,
        platform: process.platform,
        version: CUPPET_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        online: true,
        connectedAt: PROCESS_STARTED_AT,
        workspace: c.workspaceInfo(),
        provider,
      }
    },
  },

  /** v1 exposes exactly one workspace: the directory the host runs in. */
  'workspace.list': {
    scope: 'session.read',
    run: (c) => Promise.resolve([c.workspaceInfo()]),
  },

  'workspace.attach': {
    scope: 'session.write',
    run: async (c, params) => {
      const info = c.workspaceInfo()
      const requested = typeof params.workspaceId === 'string' ? params.workspaceId : ''
      if (requested && requested !== info.workspaceId) {
        throw new Error(`unknown workspace: ${requested}`)
      }
      return { ...info, attached: true }
    },
  },

  'agent.mode.get': {
    scope: 'session.read',
    run: (c) => Promise.resolve({ mode: c.snapshot.planMode ? 'plan' : 'build' }),
  },

  'agent.mode.set': {
    scope: 'session.write',
    run: async (c, params) => {
      const agent = stringParam(params, 'agent')
      if (agent !== 'plan' && agent !== 'build') throw new Error('agent must be plan or build')
      const enabled = c.syncNativeAgent(agent, optionalSession(params))
      return { agent, enabled }
    },
  },
  'status': { scope: 'session.read', run: (c) => Promise.resolve(c.status()) },
  'doctor': { scope: 'session.read', run: (c) => Promise.resolve(c.doctor()) },
  'platform.list': { scope: 'session.read', run: (c) => Promise.resolve(platformState(c)) },
  'platform.select': {
    scope: 'model.write',
    run: async (c, params) => {
      await c.selectPlatform(requireString(params, 'platform') as Platform)
      return platformState(c)
    },
  },
  'plan.toggle': {
    scope: 'session.write',
    run: async (c, params) => {
      const agent = c.snapshot.planMode ? 'build' : 'plan'
      const enabled = c.syncNativeAgent(agent, optionalSession(params))
      return { enabled, agent }
    },
  },
  'auto.status': { scope: 'session.read', run: (c) => Promise.resolve({ enabled: c.autoApprovalEnabled }) },
  'auto.set': {
    scope: 'session.write',
    run: async (c, params) => {
      if (typeof params.enabled !== 'boolean') throw new Error('auto.set requires enabled')
      return c.setAutoApprovalEnabled(params.enabled, optionalSession(params))
    },
  },
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

function stringParam(params: Record<string, unknown>, key: string): string {
  return String(params[key])
}

function optionalSession(params: Record<string, unknown>): string | undefined {
  return typeof params.sessionID === 'string' ? params.sessionID : undefined
}

function permissionParam(params: Record<string, unknown>): { id: string; sessionID: string; action?: string } {
  const raw = params.request
  if (!raw || typeof raw !== 'object') throw new Error('request is required')
  const record = raw as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.sessionID !== 'string') {
    throw new Error('request.id and request.sessionID are required')
  }
  return {
    id: record.id,
    sessionID: record.sessionID,
    ...(typeof record.action === 'string' ? { action: record.action } : {}),
  }
}

function replyValue(params: Record<string, unknown>): 'once' | 'always' | 'reject' {
  if (params.reply === 'once' || params.reply === 'always' || params.reply === 'reject') return params.reply
  throw new Error("reply must be 'once', 'always', or 'reject'")
}

/**
 * Question answers are one string[] per question in the request — an empty
 * array means "no selection for this question".
 */
function questionAnswersParam(params: Record<string, unknown>): string[][] {
  const raw = params.answers
  if (!Array.isArray(raw)) throw new Error('answers must be an array of per-question answer arrays')
  return raw.map((entry) => {
    if (!Array.isArray(entry) || entry.some((label) => typeof label !== 'string')) {
      throw new Error('each answer must be an array of strings')
    }
    return entry as string[]
  })
}
