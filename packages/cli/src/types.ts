export type ModelRef = {
  providerID: string
  modelID: string
  variant?: string | undefined
}

/** OpenCode provider identifiers are runtime data, not a closed Cuppet enum. */
export type ProviderID = string
export type ProviderId = ProviderID

/** @deprecated Use ProviderID. Kept as a source-compatible type alias. */
export type Platform = ProviderID

export type ProviderSpecialization = 'vertex'

export type ProviderCapabilities = {
  chat: boolean
  streaming: boolean
  tools: boolean
  codingAgent: boolean
}

export type ProviderDescriptor = {
  id: ProviderID
  label: string
  description: string
  integrationIds: readonly string[]
  capabilities: ProviderCapabilities
  modelCount: number
  integrationCount: number
  specialization?: ProviderSpecialization
}

export type ModelInfo = ModelRef & {
  name: string
  context: number
  output: number
  enabled: boolean
  status: 'alpha' | 'beta' | 'deprecated' | 'active'
  inputCost: number
  outputCost: number
  capabilities: {
    tools: boolean
    /** OpenCode's session API streams responses; false is an explicit opt-out. */
    streaming?: boolean
    input: string[]
    output: string[]
  }
}

export type IntegrationPrompt =
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

export type IntegrationMethod =
  | { id?: string; type: 'key'; label?: string; prompts?: IntegrationPrompt[] }
  | {
      id: string
      type: 'oauth'
      label: string
      prompts?: IntegrationPrompt[]
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

export type QuestionOption = {
  label?: string
  description?: string
  placeholder?: string
}

export type QuestionRequest = {
  id: string
  sessionID: string
  questions: Array<{
    question?: string
    header?: string
    options?: QuestionOption[]
    multiple?: boolean
  }>
  metadata?: Record<string, unknown>
}

export type AgentEvent =
  | { type: 'text-delta'; sessionID: string; text: string }
  | { type: 'reasoning-delta'; sessionID: string; text: string }
  | { type: 'tool-start'; sessionID: string; callID: string; name: string; input?: unknown }
  | { type: 'tool-progress'; sessionID: string; callID: string; message: string }
  | {
      type: 'tool-end'
      sessionID: string
      callID: string
      success: boolean
      name?: string
      outputPaths?: string[]
      input?: unknown
      diff?: string
      outputBytes: number
      resultCount: number
      truncated: boolean
      cacheHit: boolean
    }
  | { type: 'diff'; sessionID: string; diff: unknown[] }
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'permission-resolved'; sessionID: string; requestID: string; reply?: 'once' | 'always' | 'reject' }
  | { type: 'question'; request: QuestionRequest }
  | { type: 'question-resolved'; sessionID: string; requestID: string; accepted: boolean }
  | { type: 'usage'; sessionID: string; usage: TokenUsage; cost: number }
  | { type: 'idle'; sessionID: string }
  | { type: 'session'; sessionID: string; agent?: string }
  | { type: 'compaction'; sessionID: string; phase: 'started' | 'ended' }
  | { type: 'error'; sessionID?: string; message: string }
  | { type: 'step-limit'; sessionID: string; steps: number }
  | { type: 'tst-notification'; method: string; params: unknown }

export type MessageItem = {
  id: string
  sender: 'user' | 'assistant' | 'system' | 'tool' | 'reasoning'
  text: string
}
