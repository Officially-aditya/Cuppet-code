export type ModelRef = {
  providerID: string
  modelID: string
  variant?: string | undefined
}

export type Platform = 'anthropic' | 'openai' | 'google' | 'opencode' | 'vertex'

export type ModelInfo = ModelRef & {
  name: string
  context: number
  output: number
  enabled: boolean
  status: 'alpha' | 'beta' | 'deprecated' | 'active'
  inputCost: number
  outputCost: number
}

export type IntegrationMethod =
  | { id?: string; type: 'key'; label?: string }
  | {
      id: string
      type: 'oauth'
      label: string
      prompts?: Array<
        | {
            type: 'text'
            key: string
            message: string
            placeholder?: string
            when?: { key: string; op: 'eq' | 'neq'; value: string }
          }
        | {
            type: 'select'
            key: string
            message: string
            options: Array<{ label: string; value: string; hint?: string }>
            when?: { key: string; op: 'eq' | 'neq'; value: string }
          }
      >
    }
  | { id?: string; type: 'env'; names: string[] }

export type IntegrationInfo = {
  id: string
  name: string
  methods: IntegrationMethod[]
  connections: Array<{ type: string; id?: string; name?: string; label?: string }>
}

export type SessionInfo = {
  id: string
  title: string
  model?: ModelRef | undefined
  agent?: string | undefined
  cost: number
  tokens: TokenUsage
  updated: number
}

export type TokenUsage = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export type PermissionRequest = {
  id: string
  sessionID: string
  action: string
  resources: string[]
  save?: string[]
  metadata?: Record<string, unknown>
}

export type AgentEvent =
  | { type: 'text-delta'; sessionID: string; text: string }
  | { type: 'reasoning-delta'; sessionID: string; text: string }
  | { type: 'tool-start'; sessionID: string; callID: string; name: string; input?: unknown }
  | { type: 'tool-progress'; sessionID: string; callID: string; message: string }
  | { type: 'tool-end'; sessionID: string; callID: string; success: boolean; outputPaths?: string[] }
  | { type: 'diff'; sessionID: string; diff: unknown[] }
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'usage'; sessionID: string; usage: TokenUsage; cost: number }
  | { type: 'idle'; sessionID: string }
  | { type: 'compaction'; sessionID: string; phase: 'started' | 'ended' }
  | { type: 'error'; sessionID?: string; message: string }
  | { type: 'step-limit'; sessionID: string; steps: number }
  | { type: 'tst-notification'; method: string; params: unknown }

export type MessageItem = {
  id: string
  sender: 'user' | 'assistant' | 'system' | 'tool' | 'reasoning'
  text: string
}
