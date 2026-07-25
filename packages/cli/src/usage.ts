import type { TokenUsage } from './types.js'

// Cache counters are a breakdown of input usage, not additional tokens.
export function totalTokenUsage(usage: TokenUsage): number {
  return usage.input + usage.output + usage.reasoning
}

export function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) {
    return '0'
  }
  if (count < 1000) {
    return Math.floor(count).toString()
  }
  const units = [
    { value: 1_000_000_000, suffix: 'B' },
    { value: 1_000_000, suffix: 'M' },
    { value: 1_000, suffix: 'k' },
  ]
  for (const { value, suffix } of units) {
    if (count >= value) {
      const formatted = Math.floor(count / (value / 10)) / 10
      return `${formatted}${suffix}`
    }
  }
  return Math.floor(count).toString()
}

