import type { IntegrationInfo, ModelRef, Platform } from './types.js'

export const PLATFORM_OPTIONS: ReadonlyArray<{
  value: Platform
  label: string
  description: string
}> = [
  { value: 'anthropic', label: 'Anthropic', description: 'Claude models' },
  { value: 'openai', label: 'OpenAI', description: 'OpenAI and Azure OpenAI models' },
  { value: 'google', label: 'Google', description: 'Gemini models' },
  { value: 'opencode', label: 'OpenCode', description: 'OpenCode-provided models' },
  { value: 'vertex', label: 'Vertex AI', description: 'Google Cloud ADC & Vertex AI models' },
]

const modelProviderIDs: Record<Platform, ReadonlySet<string>> = {
  anthropic: new Set(['anthropic']),
  openai: new Set(['openai', 'azure', 'azure-openai']),
  google: new Set(['google', 'google-vertex', 'vertex', 'vertex-ai', 'vertexai', 'gemini']),
  opencode: new Set(['opencode']),
  vertex: new Set(['vertex', 'google-vertex', 'vertex-ai', 'vertexai', 'google']),
}

export function modelMatchesPlatform(model: Pick<ModelRef, 'providerID'>, platform: Platform): boolean {
  return modelProviderIDs[platform]?.has(model.providerID.toLowerCase()) ?? false
}

export function integrationMatchesPlatform(
  integration: Pick<IntegrationInfo, 'id' | 'name'>,
  platform: Platform,
): boolean {
  const value = `${integration.id} ${integration.name}`.toLowerCase()
  if (platform === 'anthropic') return value.includes('anthropic')
  if (platform === 'openai') return value.includes('openai') || value.includes('azure')
  if (platform === 'google') {
    return value.includes('google') || value.includes('gemini')
  }
  if (platform === 'vertex') {
    return value.includes('vertex') || value.includes('gcp') || value.includes('google')
  }
  return value.includes('opencode')
}

export function platformLabel(platform: Platform): string {
  return PLATFORM_OPTIONS.find((option) => option.value === platform)?.label ?? platform
}
