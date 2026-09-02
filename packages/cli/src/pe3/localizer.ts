import type { TaskAgentEvidence } from './task-agents.js'
import type { TstClient } from '../tst/client.js'

type GraphResult = {
  score?: number
  node?: {
    path?: string
    name?: string
  }
}

type QueryResult = {
  graph?: GraphResult[]
}

const MAX_LOCALIZED_PATHS = 6
const MAX_LOCALIZED_SYMBOLS = 8

/**
 * Cheap code-localization pass before semantic escalation.
 *
 * This reuses the local TST graph query already used for foreground context;
 * it does not invoke a language model and it never promotes retrieved memory
 * into task identity. Only bounded path/symbol hints are returned.
 */
export class TstTaskLocalizer {
  readonly #client: TstClient | undefined

  constructor(client: TstClient | undefined) {
    this.#client = client
  }

  async locate(sessionID: string, prompt: string): Promise<TaskAgentEvidence> {
    if (!this.#client?.connected || !prompt.trim()) return {}
    const result = await this.#client.call<QueryResult>('memory.query', {
      session_id: sessionID,
      query: prompt,
      limit: 12,
    }).catch(() => ({} as QueryResult))
    const graph = (result.graph ?? [])
      .filter((item): item is GraphResult & { node: { path?: string; name?: string } } => Boolean(item?.node))
      .sort((left, right) => finiteScore(right.score) - finiteScore(left.score))
    if (graph.length === 0) return {}

    const topScore = Math.max(0, finiteScore(graph[0]!.score))
    const relativeFloor = topScore > 0 ? topScore * 0.55 : 0
    const selected = graph.filter((item, index) => {
      if (index === 0) return true
      const score = finiteScore(item.score)
      return score >= relativeFloor
    }).slice(0, 10)

    const localizedPaths = unique(
      selected.flatMap((item) => typeof item.node.path === 'string' ? [item.node.path] : []),
      MAX_LOCALIZED_PATHS,
    )
    const localizedSymbols = unique(
      selected.flatMap((item) => typeof item.node.name === 'string' ? [item.node.name] : []),
      MAX_LOCALIZED_SYMBOLS,
    )
    return {
      ...(localizedPaths.length ? { localizedPaths } : {}),
      ...(localizedSymbols.length ? { localizedSymbols } : {}),
    }
  }
}

function finiteScore(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function unique(values: string[], limit: number): string[] {
  const output: string[] = []
  const seen = new Set<string>()
  for (const raw of values) {
    const value = raw.trim()
    const key = value.toLowerCase()
    if (!value || seen.has(key)) continue
    seen.add(key)
    output.push(value)
    if (output.length >= limit) break
  }
  return output
}
