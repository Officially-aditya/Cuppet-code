import type { IntegrationInfo, ModelRef, Platform } from './types.js'

export const PLATFORM_OPTIONS: ReadonlyArray<{
  value: Platform
  label: string
  description: string
}> = [
  { value: 'anthropic', label: 'Anthropic', description: 'Claude models' },
  { value: 'openai', label: 'OpenAI', description: 'OpenAI and Azure OpenAI models' },
  { value: 'google', label: 'Google', description: 'Gemini API models' },
  { value: 'opencode', label: 'OpenCode', description: 'OpenCode-provided models' },
  { value: 'vertex', label: 'Vertex AI', description: 'Google Cloud ADC models' },
]

const modelProviderIDs: Record<Platform, ReadonlySet<string>> = {
  anthropic: new Set(['anthropic']),
  openai: new Set(['openai', 'azure', 'azure-openai']),
  google: new Set(['google']),
  opencode: new Set(['opencode']),
  vertex: new Set(['google-vertex', 'google-vertex-anthropic']),
}

export function modelMatchesPlatform(model: Pick<ModelRef, 'providerID'>, platform: Platform): boolean {
  return modelProviderIDs[platform]?.has(model.providerID.toLowerCase()) ?? false
}

export function integrationMatchesPlatform(
  integration: Pick<IntegrationInfo, 'id' | 'name'>,
  platform: Platform,
): boolean {
  const id = integration.id.toLowerCase()
  if (platform === 'anthropic') return id === 'anthropic'
  if (platform === 'openai') return id === 'openai' || id === 'azure' || id === 'azure-openai'
  if (platform === 'google') return id === 'google'
  if (platform === 'vertex') return id === 'google-vertex' || id === 'google-vertex-anthropic'
  return id === 'opencode'
}

export function platformLabel(platform: Platform): string {
  return PLATFORM_OPTIONS.find((option) => option.value === platform)?.label ?? platform
}
