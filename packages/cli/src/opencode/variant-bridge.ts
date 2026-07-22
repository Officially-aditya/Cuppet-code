import type { ModelV2Info, Provider as LegacyProvider } from '@opencode-ai/sdk/v2'

export type VariantBridge = {
  schema: 1
  models: Array<{
    providerID: string
    modelID: string
    variants: Array<{ id: string; headers: Record<string, string>; body: Record<string, unknown> }>
  }>
}

export function buildVariantBridge(models: ModelV2Info[], providers: LegacyProvider[]): VariantBridge {
  const legacy = new Map(providers.map((provider) => [provider.id, provider]))
  return {
    schema: 1,
    models: models.flatMap((model) => {
      const source = legacy.get(model.providerID)?.models[model.id]
      const existing = new Set(model.variants.map((variant) => variant.id))
      const variants = Object.entries(source?.variants ?? {}).flatMap(([id, options]) => {
        if (existing.has(id)) return []
        const body = lowerVariant(model, removeSecrets(options))
        return [{ id, headers: {}, body }]
      })
      return variants.length > 0 ? [{ providerID: model.providerID, modelID: model.id, variants }] : []
    }),
  }
}

function lowerVariant(model: ModelV2Info, options: Record<string, unknown>): Record<string, unknown> {
  if (model.api.type !== 'aisdk') return mergeNestedRequest(model.request.body, options)
  const packageName = model.api.package
  let body: Record<string, unknown>
  if (packageName === '@ai-sdk/openai' || packageName === '@ai-sdk/azure') {
    body = snake(options)
    if (options.reasoningEffort !== undefined || options.reasoningSummary !== undefined) {
      body.reasoning = {
        ...(isRecord(body.reasoning) ? body.reasoning : {}),
        ...(options.reasoningEffort !== undefined ? { effort: options.reasoningEffort } : {}),
        ...(options.reasoningSummary !== undefined ? { summary: options.reasoningSummary } : {}),
      }
      delete body.reasoning_effort
      delete body.reasoning_summary
    }
    if (options.textVerbosity !== undefined) {
      body.text = { ...(isRecord(body.text) ? body.text : {}), verbosity: options.textVerbosity }
      delete body.text_verbosity
    }
  } else if (packageName === '@ai-sdk/anthropic' || packageName === '@ai-sdk/google-vertex/anthropic') {
    body = snake(options)
    if (options.effort !== undefined || options.taskBudget !== undefined) {
      body.output_config = compact({ effort: options.effort, task_budget: options.taskBudget })
      delete body.effort
      delete body.task_budget
    }
  } else if (packageName === '@ai-sdk/google' || packageName === '@ai-sdk/google-vertex') {
    const generationKeys = new Set(['thinkingConfig', 'responseModalities', 'mediaResolution', 'imageConfig'])
    const generationConfig = Object.fromEntries(Object.entries(options).filter(([key]) => generationKeys.has(key)))
    body = {
      ...Object.fromEntries(Object.entries(options).filter(([key]) => !generationKeys.has(key))),
      ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
    }
  } else if (packageName === '@ai-sdk/amazon-bedrock') {
    body = { additionalModelRequestFields: options }
  } else if (openAICompatiblePackages.has(packageName)) {
    body = { ...options }
    if (options.reasoningEffort !== undefined) {
      body.reasoning_effort = options.reasoningEffort
      delete body.reasoningEffort
    }
  } else body = { ...options }
  return mergeNestedRequest(model.request.body, body)
}

const openAICompatiblePackages = new Set([
  '@ai-sdk/openai-compatible',
  '@ai-sdk/cerebras',
  '@ai-sdk/deepinfra',
  '@ai-sdk/groq',
  '@ai-sdk/mistral',
  '@ai-sdk/togetherai',
  '@ai-sdk/xai',
  '@openrouter/ai-sdk-provider',
  'ai-gateway-provider',
  'venice-ai-sdk-provider',
])

function removeSecrets(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const normalized = key.replaceAll(/[-_]/g, '').toLowerCase()
      if (secretKeys.has(normalized)) return []
      if (Array.isArray(item)) return [[key, item.map((entry) => isRecord(entry) ? removeSecrets(entry) : entry)]]
      return [[key, isRecord(item) ? removeSecrets(item) : item]]
    }),
  )
}

const secretKeys = new Set([
  'apikey',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'password',
  'clientsecret',
  'credential',
  'headers',
])

function mergeNestedRequest(base: Record<string, unknown>, variant: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(variant).map(([key, value]) => [
      key,
      isRecord(base[key]) && isRecord(value) ? deepMerge(base[key], value) : value,
    ]),
  )
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  return {
    ...base,
    ...Object.fromEntries(
      Object.entries(override).map(([key, value]) => [
        key,
        isRecord(base[key]) && isRecord(value) ? deepMerge(base[key], value) : value,
      ]),
    ),
  }
}

function snake(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [snakeKey(key), snakeValue(item)]))
}

function snakeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(snakeValue)
  if (!isRecord(value)) return value
  return snake(value)
}

function snakeKey(key: string) {
  return key.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`)
}

function compact(value: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
