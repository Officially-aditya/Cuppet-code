import type { TokenUsage } from './types.js'

// Cache counters are a breakdown of input usage, not additional tokens.
export function totalTokenUsage(usage: TokenUsage): number {
  return usage.input + usage.output + usage.reasoning
}
