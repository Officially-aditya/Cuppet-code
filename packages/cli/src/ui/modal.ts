import type {
  IntegrationInfo,
  IntegrationMethod,
  PermissionRequest,
  Platform,
  SessionInfo,
} from '../types.js'

type OAuthMethod = Extract<IntegrationMethod, { type: 'oauth' }>

export type Modal =
  | { type: 'none' }
  | { type: 'status'; data: Record<string, unknown> }
  | { type: 'platform'; required: boolean }
  | { type: 'model'; role: 'primary' | 'secondary'; required: boolean }
  | { type: 'effort'; role: 'primary' | 'secondary'; options: string[] }
  | { type: 'login-integration'; provider?: string; platform?: Platform; required?: boolean }
  | { type: 'login-method'; integration: IntegrationInfo }
  | { type: 'login-key'; integration: IntegrationInfo }
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
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'confirm-clear'; scope: 'session' | 'project' | 'global' }
  | { type: 'step-limit'; sessionID: string }

export function previousModal(modal: Modal): Modal {
  switch (modal.type) {
    case 'model':
      if (!modal.required) return { type: 'none' }
      return modal.role === 'secondary'
        ? { type: 'model', role: 'primary', required: true }
        : { type: 'platform', required: true }
    case 'login-integration':
      return modal.required ? { type: 'platform', required: true } : { type: 'none' }
    case 'login-method':
      return { type: 'login-integration', provider: modal.integration.id }
    case 'login-key':
    case 'oauth-prompt':
    case 'oauth-wait':
      return { type: 'login-method', integration: modal.integration }
    default:
      return { type: 'none' }
  }
}
