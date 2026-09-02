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

export type TaskLocalizationMetadata = {
  topScore: number
  runnerUpScore?: number
  decisive: boolean
  reason: string
}

export type TaskLocalizationEvidence = TaskAgentEvidence & {
  localization?: TaskLocalizationMetadata
}

const MAX_LOCALIZED_PATHS = 6
const MAX_LOCALIZED_SYMBOLS = 8
const DECISIVE_SCORE_FLOOR = 0.55
const DECISIVE_MARGIN = 0.08

/**
 * Cheap code-localization pass before semantic escalation.
 *
 * Weak/noisy graph matches remain observable as calibration metadata but are
 * not promoted into localized path/symbol evidence. Only a sufficiently high
 * top score with separation from the runner-up can settle routing without the
 * semantic fallback.
 */
export class TstTaskLocalizer {
  readonly #client: TstClient | undefined

  constructor(client: TstClient | undefined) {
    this.#client = client
  }

  async locate(sessionID: string, prompt: string): Promise<TaskLocalizationEvidence> {
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
    const runnerUpScore = graph.length > 1 ? Math.max(0, finiteScore(graph[1]!.score)) : undefined
    const margin = runnerUpScore === undefined ? topScore : topScore - runnerUpScore
    const decisive = topScore >= DECISIVE_SCORE_FLOOR && margin >= DECISIVE_MARGIN
    const localization: TaskLocalizationMetadata = {
      topScore,
      ...(runnerUpScore !== undefined ? { runnerUpScore } : {}),
      decisive,
      reason: decisive
        ? 'graph localization cleared absolute score and winner-margin thresholds'
        : topScore < DECISIVE_SCORE_FLOOR
          ? 'graph localization top score is below the hard-evidence floor'
          : 'graph localization winner margin is too small for hard evidence',
    }

    if (!decisive) return { localization }

    const relativeFloor = topScore * 0.55
    const selected = graph.filter((item, index) => {
      if (index === 0) return true
      return finiteScore(item.score) >= relativeFloor
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
      localization,
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
