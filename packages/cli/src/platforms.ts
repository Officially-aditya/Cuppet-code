import type {
  IntegrationInfo,
  ModelInfo,
  ModelRef,
  Platform,
  ProviderCapabilities,
  ProviderDescriptor,
  ProviderID,
  ProviderSpecialization,
} from './types.js'

export type {
  ProviderCapabilities,
  ProviderDescriptor,
  ProviderID,
  ProviderSpecialization,
} from './types.js'

export type ProviderOverride = {
  label?: string
  description?: string
  integrationIds?: readonly string[]
  specialization?: ProviderSpecialization
}

/**
 * Cuppet-specific metadata and grouping rules. This is intentionally not a
 * provider registry: any provider reported by OpenCode is included even when
 * it has no entry here.
 */
export const PROVIDER_OVERRIDES: Readonly<Record<string, ProviderOverride>> = {
  anthropic: {
    label: 'Anthropic',
    description: 'Claude models',
  },
  openai: {
    label: 'OpenAI',
    description: 'OpenAI and Azure OpenAI models',
    integrationIds: ['openai', 'azure', 'azure-openai'],
  },
  google: {
    label: 'Google',
    description: 'Gemini API models',
  },
  opencode: {
    label: 'OpenCode',
    description: 'OpenCode-provided models',
  },
  vertex: {
    label: 'Vertex AI',
    description: 'Google Cloud ADC models',
    integrationIds: ['google-vertex', 'google-vertex-anthropic', 'vertex'],
    specialization: 'vertex',
  },
}

const DISPLAY_ACRONYMS = new Map([
  ['ai', 'AI'],
  ['api', 'API'],
  ['adc', 'ADC'],
  ['azure', 'Azure'],
  ['gpt', 'GPT'],
  ['llm', 'LLM'],
  ['nim', 'NIM'],
  ['nvidia', 'NVIDIA'],
  ['openai', 'OpenAI'],
  ['opencode', 'OpenCode'],
])

export const CODING_AGENT_REQUIREMENTS = {
  chat: true,
  streaming: true,
  tools: true,
} as const

/**
 * Build the Cuppet-facing provider catalog from the current OpenCode model
 * and integration projections. Integrations without models remain visible so
 * users can authenticate them before OpenCode exposes executable models.
 */
export function buildProviderCatalog(
  models: readonly ModelInfo[],
  integrations: readonly IntegrationInfo[],
): ProviderDescriptor[] {
  const observedIDs = new Set<string>()
  for (const model of models) addObservedID(observedIDs, model.providerID)
  for (const integration of integrations) addObservedID(observedIDs, integration.id)

  const groups = new Map<string, { sourceIDs: Set<string>; override: ProviderOverride | undefined }>()
  for (const sourceID of observedIDs) {
    const group = providerGroupFor(sourceID)
    const current = groups.get(group.id) ?? { sourceIDs: new Set<string>(), override: group.override }
    current.sourceIDs.add(sourceID)
    groups.set(group.id, current)
  }

  return [...groups.entries()]
    .map(([id, group]) => {
      const override = group.override
      const integrationIds = uniqueIDs([
        id,
        ...(override?.integrationIds ?? []),
        ...group.sourceIDs,
      ])
      const groupModels = models.filter((model) => matchesAnyID(model.providerID, integrationIds))
      const groupIntegrations = integrations.filter((integration) => matchesAnyID(integration.id, integrationIds))
      const capabilities = capabilitiesFor(groupModels)
      const label = override?.label ?? humanizeProviderId(id)
      return {
        id,
        label,
        description: override?.description ?? `${label} models`,
        integrationIds,
        capabilities,
        modelCount: groupModels.length,
        integrationCount: groupIntegrations.length,
        ...(override?.specialization ? { specialization: override.specialization } : {}),
      } satisfies ProviderDescriptor
    })
    .sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id))
}

/** Alias used by callers that prefer catalog terminology. */
export const createProviderCatalog = buildProviderCatalog

export function humanizeProviderId(providerID: ProviderID): string {
  const words = normalizeProviderID(providerID).split(/[-_.\s]+/).filter(Boolean)
  if (words.length === 0) return providerID
  return words
    .map((word) => DISPLAY_ACRONYMS.get(word) ?? `${word[0]!.toUpperCase()}${word.slice(1)}`)
    .join(' ')
}

export function providerLabel(providerID: ProviderID): string {
  const override = providerGroupFor(providerID).override
  return override?.label ?? humanizeProviderId(providerID)
}

export function providerDescriptorFor(
  providerID: ProviderID,
  catalog: readonly ProviderDescriptor[],
): ProviderDescriptor | undefined {
  const normalized = normalizeProviderID(providerID)
  return catalog.find(
    (provider) => normalizeProviderID(provider.id) === normalized ||
      provider.integrationIds.some((id) => normalizeProviderID(id) === normalized),
  )
}

export function modelMatchesProvider(
  model: Pick<ModelRef, 'providerID'>,
  provider: ProviderDescriptor | ProviderID,
): boolean {
  const descriptor = typeof provider === 'string'
    ? descriptorForID(provider)
    : provider
  return descriptor.integrationIds.some((id) => sameProviderID(model.providerID, id))
}

export function integrationMatchesProvider(
  integration: Pick<IntegrationInfo, 'id' | 'name'>,
  provider: ProviderDescriptor | ProviderID,
): boolean {
  const descriptor = typeof provider === 'string'
    ? descriptorForID(provider)
    : provider
  return descriptor.integrationIds.some((id) => sameProviderID(integration.id, id))
}

export function providerSupportsCodingAgent(provider: ProviderDescriptor): boolean {
  return provider.capabilities.codingAgent
}

export function modelSupportsCodingAgent(model: Pick<ModelInfo, 'capabilities'>): boolean {
  return isChatModel(model) && isStreamingModel(model) && model.capabilities.tools
}

export function missingCodingAgentCapabilities(provider: ProviderDescriptor): string[] {
  const missing: string[] = []
  if (!provider.capabilities.chat) missing.push('chat')
  if (!provider.capabilities.streaming) missing.push('streaming')
  if (!provider.capabilities.tools) missing.push('tool calling')
  if (missing.length === 0 && !provider.capabilities.codingAgent) {
    missing.push('a model with both streaming and tool calling')
  }
  return missing
}

/**
 * Validate a provider only when it has executable models. Integration-only
 * providers are allowed through so the user can connect them first.
 */
export function validateProviderCapabilities(provider: ProviderDescriptor): void {
  if (provider.modelCount === 0) return
  const missing = missingCodingAgentCapabilities(provider)
  if (missing.length > 0) {
    throw new Error(`${provider.label} does not support Cuppet coding requirements: ${missing.join(', ')}`)
  }
}

/**
 * Compatibility wrappers for integrations that still call these functions by
 * their old platform names. The matching itself is provider-generic.
 */
export function modelMatchesPlatform(model: Pick<ModelRef, 'providerID'>, platform: Platform): boolean {
  return modelMatchesProvider(model, platform)
}

export function integrationMatchesPlatform(
  integration: Pick<IntegrationInfo, 'id' | 'name'>,
  platform: Platform,
): boolean {
  return integrationMatchesProvider(integration, platform)
}

/** @deprecated Use providerLabel. */
export function platformLabel(platform: Platform): string {
  return providerLabel(platform)
}

function capabilitiesFor(models: readonly ModelInfo[]): ProviderCapabilities {
  const chatModels = models.filter(isChatModel)
  const streamingModels = chatModels.filter(isStreamingModel)
  const toolModels = chatModels.filter((model) => model.capabilities.tools)
  return {
    chat: chatModels.length > 0,
    streaming: streamingModels.length > 0,
    tools: toolModels.length > 0,
    codingAgent: toolModels.some(isStreamingModel),
  }
}

function isChatModel(model: Pick<ModelInfo, 'capabilities'>): boolean {
  return model.capabilities.input.includes('text') && model.capabilities.output.includes('text')
}

function isStreamingModel(model: Pick<ModelInfo, 'capabilities'>): boolean {
  return model.capabilities.streaming !== false
}

function descriptorForID(providerID: ProviderID): ProviderDescriptor {
  const group = providerGroupFor(providerID)
  const override = group.override
  const integrationIds = uniqueIDs([group.id, ...(override?.integrationIds ?? [])])
  return {
    id: group.id,
    label: override?.label ?? humanizeProviderId(group.id),
    description: override?.description ?? `${override?.label ?? humanizeProviderId(group.id)} models`,
    integrationIds,
    capabilities: {
      chat: false,
      streaming: false,
      tools: false,
      codingAgent: false,
    },
    modelCount: 0,
    integrationCount: 0,
    ...(override?.specialization ? { specialization: override.specialization } : {}),
  }
}

function providerGroupFor(providerID: ProviderID): { id: string; override?: ProviderOverride } {
  const normalized = normalizeProviderID(providerID)
  for (const [id, override] of Object.entries(PROVIDER_OVERRIDES)) {
    if (normalized === id || override.integrationIds?.some((candidate) => normalizeProviderID(candidate) === normalized)) {
      return { id, override }
    }
  }
  return { id: normalized }
}

function addObservedID(target: Set<string>, value: string): void {
  const normalized = normalizeProviderID(value)
  if (normalized) target.add(normalized)
}

function uniqueIDs(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeProviderID).filter(Boolean))]
}

function matchesAnyID(value: string, ids: readonly string[]): boolean {
  return ids.some((id) => sameProviderID(value, id))
}

function sameProviderID(left: string, right: string): boolean {
  return normalizeProviderID(left) === normalizeProviderID(right)
}

function normalizeProviderID(value: string): string {
  return value.trim().toLowerCase()
}
