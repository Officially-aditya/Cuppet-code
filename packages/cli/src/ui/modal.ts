import type {
  IntegrationInfo,
  IntegrationMethod,
  ModelRef,
  PermissionRequest,
  Platform,
  SessionInfo,
} from '../types.js'

type OAuthMethod = Extract<IntegrationMethod, { type: 'oauth' }>
type KeyMethod = Extract<IntegrationMethod, { type: 'key' }>

export type Modal =
  | { type: 'none' }
  | { type: 'status'; data: Record<string, unknown> }
  | { type: 'platform'; required: boolean }
  | { type: 'vertex-setup'; required: boolean }
  | { type: 'model'; role: 'primary' | 'secondary'; required: boolean }
  | {
      type: 'effort'
      role: 'primary' | 'secondary'
      options: string[]
      /** A model picked immediately before choosing its effort. */
      model?: ModelRef
      /** Return to the model list instead of dismissing on Esc. */
      returnToModel?: boolean
      required?: boolean
    }
  | { type: 'login-integration'; provider?: string; platform?: Platform; required?: boolean }
  | { type: 'login-method'; integration: IntegrationInfo }
  | { type: 'login-key'; integration: IntegrationInfo; method?: KeyMethod; metadata?: Record<string, string> }
  | {
      type: 'key-prompt'
      integration: IntegrationInfo
      method: KeyMethod
      index: number
      inputs: Record<string, string>
    }
  | {
      type: 'oauth-prompt'
      integration: IntegrationInfo
      method: OAuthMethod
      index: number
      inputs: Record<string, string>
    }
  | {
      type: 'oauth-wait'
      integration: IntegrationInfo
      method: OAuthMethod
      attemptID: string
      url: string
      instructions: string
      mode: 'auto' | 'code'
    }
  | { type: 'sessions'; sessions: SessionInfo[] }
  | { type: 'permission'; request: PermissionRequest; queue?: PermissionRequest[] }
  | { type: 'confirm-clear'; scope: 'session' | 'project' | 'global' }
  | { type: 'step-limit'; sessionID: string }

export function previousModal(modal: Modal): Modal {
  switch (modal.type) {
    case 'model':
      if (!modal.required) return { type: 'none' }
      return modal.role === 'secondary'
        ? { type: 'model', role: 'primary', required: true }
        : { type: 'platform', required: true }
    case 'effort':
      return modal.returnToModel
        ? { type: 'model', role: modal.role, required: modal.required ?? false }
        : { type: 'none' }
    case 'login-integration':
      return modal.required ? { type: 'platform', required: true } : { type: 'none' }
    case 'vertex-setup':
      return modal.required ? { type: 'platform', required: true } : { type: 'none' }
    case 'login-method':
      return { type: 'login-integration', provider: modal.integration.id }
    case 'login-key':
    case 'key-prompt':
    case 'oauth-prompt':
    case 'oauth-wait':
      return { type: 'login-method', integration: modal.integration }
    default:
      return { type: 'none' }
  }
}

export function nextPermissionModal(modal: Extract<Modal, { type: 'permission' }>): Modal {
  const queue = modal.queue ?? []
  return queue.length > 0
    ? { type: 'permission', request: queue[0]!, queue: queue.slice(1) }
    : { type: 'none' }
}
