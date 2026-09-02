import { taskFingerprintText, type TaskAgentState } from './task-agents.js'

export interface TaskEmbeddingProvider {
  readonly modelID: string
  embed(text: string): Promise<Float32Array>
}

export type SemanticRoutingThresholds = {
  /** Similarity above which the active task is safely retained. */
  activeContinueMin: number
  /** Minimum absolute similarity required to reactivate a dormant task. */
  dormantMatchMin: number
  /** Dormant match must beat active by at least this margin. */
  dormantActiveMargin: number
  /** Dormant winner must beat the next dormant candidate by this margin. */
  dormantRunnerUpMargin: number
  /** All known tasks must be below this score before a new task is created. */
  noveltyMax: number
}

/**
 * Provisional calibration values. They are deliberately constructor-overridable
 * and should be tuned from the PE3 benchmark traces rather than treated as a
 * permanent property of any particular embedding model.
 */
export const DEFAULT_SEMANTIC_THRESHOLDS: SemanticRoutingThresholds = {
  activeContinueMin: 0.52,
  dormantMatchMin: 0.60,
  dormantActiveMargin: 0.10,
  dormantRunnerUpMargin: 0.04,
  noveltyMax: 0.34,
}

export type SemanticRouteDecision = {
  action: 'continue' | 'reactivate' | 'create'
  agent?: TaskAgentState
  reason: string
  confidence: number
  modelID: string
  activeSimilarity: number
  bestDormantSimilarity?: number
  runnerUpDormantSimilarity?: number
  promptEmbeddingCount: number
  agentEmbeddingCount: number
  embeddingLatencyMs: number
  fallback: boolean
  error?: string
}

type CachedVector = {
  signature: string
  vector: Float32Array
}

/**
 * Narrow semantic escalation layer for PE3.
 *
 * It embeds the incoming prompt exactly once, reuses cached task-fingerprint
 * vectors, compares dormant agents before considering novelty, and fails
 * closed to the active task on any unavailable/low-confidence result.
 */
export class SemanticTaskRouter {
  readonly #provider: TaskEmbeddingProvider
  readonly #thresholds: SemanticRoutingThresholds
  readonly #cache = new Map<string, CachedVector>()
  readonly #now: () => number

  constructor(
    provider: TaskEmbeddingProvider,
    thresholds: Partial<SemanticRoutingThresholds> = {},
    options: { now?: () => number } = {},
  ) {
    this.#provider = provider
    this.#thresholds = { ...DEFAULT_SEMANTIC_THRESHOLDS, ...thresholds }
    this.#now = options.now ?? Date.now
  }

  get modelID(): string {
    return this.#provider.modelID
  }

  get thresholds(): SemanticRoutingThresholds {
    return { ...this.#thresholds }
  }

  async decide(prompt: string, active: TaskAgentState, dormant: TaskAgentState[]): Promise<SemanticRouteDecision> {
    const startedAt = this.#now()
    let promptEmbeddingCount = 0
    let agentEmbeddingCount = 0
    try {
      // The prompt is intentionally embedded once and then compared directly
      // with all cached/derived task vectors.
      const promptVector = await this.#provider.embed(prompt)
      promptEmbeddingCount = 1
      ensureVector(promptVector)

      const activeResult = await this.#taskVector(active)
      agentEmbeddingCount += activeResult.created ? 1 : 0
      const activeSimilarity = cosineSimilarity(promptVector, activeResult.vector)

      const dormantScores: Array<{ agent: TaskAgentState; similarity: number }> = []
      for (const agent of dormant) {
        const result = await this.#taskVector(agent)
        agentEmbeddingCount += result.created ? 1 : 0
        dormantScores.push({ agent, similarity: cosineSimilarity(promptVector, result.vector) })
      }
      dormantScores.sort((left, right) => right.similarity - left.similarity || right.agent.lastActiveAt - left.agent.lastActiveAt)

      const best = dormantScores[0]
      const runnerUp = dormantScores[1]
      const dormantBeatsActive = best
        ? best.similarity - activeSimilarity >= this.#thresholds.dormantActiveMargin
        : false
      const dormantWinsField = best
        ? best.similarity - (runnerUp?.similarity ?? -1) >= this.#thresholds.dormantRunnerUpMargin
        : false

      // Search dormant identities before creating another task. This preserves
      // old provider-cache/task state whenever there is a decisive semantic
      // return even if the user uses completely different wording.
      if (
        best
        && best.similarity >= this.#thresholds.dormantMatchMin
        && dormantBeatsActive
        && dormantWinsField
      ) {
        return {
          action: 'reactivate',
          agent: cloneAgent(best.agent),
          reason: 'semantic task fingerprint decisively matches a dormant agent',
          confidence: clamp01(Math.min(best.similarity, best.similarity - activeSimilarity + 0.5)),
          modelID: this.#provider.modelID,
          activeSimilarity,
          bestDormantSimilarity: best.similarity,
          ...(runnerUp ? { runnerUpDormantSimilarity: runnerUp.similarity } : {}),
          promptEmbeddingCount,
          agentEmbeddingCount,
          embeddingLatencyMs: Math.max(0, this.#now() - startedAt),
          fallback: false,
        }
      }

      if (activeSimilarity >= this.#thresholds.activeContinueMin) {
        return {
          action: 'continue',
          reason: 'semantic task fingerprint supports the active agent',
          confidence: clamp01(activeSimilarity),
          modelID: this.#provider.modelID,
          activeSimilarity,
          ...(best ? { bestDormantSimilarity: best.similarity } : {}),
          ...(runnerUp ? { runnerUpDormantSimilarity: runnerUp.similarity } : {}),
          promptEmbeddingCount,
          agentEmbeddingCount,
          embeddingLatencyMs: Math.max(0, this.#now() - startedAt),
          fallback: false,
        }
      }

      const bestKnownSimilarity = Math.max(activeSimilarity, best?.similarity ?? -1)
      if (bestKnownSimilarity <= this.#thresholds.noveltyMax) {
        return {
          action: 'create',
          reason: 'semantic novelty is low against every known task agent',
          confidence: clamp01(1 - bestKnownSimilarity),
          modelID: this.#provider.modelID,
          activeSimilarity,
          ...(best ? { bestDormantSimilarity: best.similarity } : {}),
          ...(runnerUp ? { runnerUpDormantSimilarity: runnerUp.similarity } : {}),
          promptEmbeddingCount,
          agentEmbeddingCount,
          embeddingLatencyMs: Math.max(0, this.#now() - startedAt),
          fallback: false,
        }
      }

      // The expensive failure mode is a false split. A middling similarity or
      // close dormant race is therefore not a routing decision: keep the active
      // cache-friendly session and wait for stronger future evidence.
      return {
        action: 'continue',
        reason: 'semantic evidence is low-confidence; preserve the active task',
        confidence: clamp01(activeSimilarity),
        modelID: this.#provider.modelID,
        activeSimilarity,
        ...(best ? { bestDormantSimilarity: best.similarity } : {}),
        ...(runnerUp ? { runnerUpDormantSimilarity: runnerUp.similarity } : {}),
        promptEmbeddingCount,
        agentEmbeddingCount,
        embeddingLatencyMs: Math.max(0, this.#now() - startedAt),
        fallback: true,
      }
    } catch (error) {
      return {
        action: 'continue',
        reason: 'semantic routing unavailable; deterministic fallback preserves the active task',
        confidence: 0,
        modelID: this.#provider.modelID,
        activeSimilarity: 0,
        promptEmbeddingCount,
        agentEmbeddingCount,
        embeddingLatencyMs: Math.max(0, this.#now() - startedAt),
        fallback: true,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  clear(agentID?: string): void {
    if (!agentID) {
      this.#cache.clear()
      return
    }
    this.#cache.delete(agentID)
  }

  async #taskVector(agent: TaskAgentState): Promise<{ vector: Float32Array; created: boolean }> {
    const signature = fingerprintSignature(agent)
    const cached = this.#cache.get(agent.id)
    if (cached?.signature === signature) return { vector: cached.vector, created: false }
    const text = taskFingerprintText(agent) || agent.taskDescriptor || `task session ${agent.sessionID}`
    const vector = await this.#provider.embed(text)
    ensureVector(vector)
    this.#cache.set(agent.id, { signature, vector })
    return { vector, created: true }
  }
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length === 0 || left.length !== right.length) throw new Error('embedding dimension mismatch')
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm <= 0 || rightNorm <= 0) throw new Error('embedding vector has zero norm')
  return dot / Math.sqrt(leftNorm * rightNorm)
}

function fingerprintSignature(agent: TaskAgentState): string {
  return [agent.fingerprint.revision, agent.cacheEpoch, agent.workspaceEpoch, agent.taskDescriptor].join(':')
}

function ensureVector(vector: Float32Array): void {
  if (!(vector instanceof Float32Array) || vector.length === 0) throw new Error('embedding provider returned an empty vector')
  for (const value of vector) if (!Number.isFinite(value)) throw new Error('embedding provider returned a non-finite vector')
}

function cloneAgent(agent: TaskAgentState): TaskAgentState {
  return {
    ...agent,
    activePaths: [...agent.activePaths],
    touchedPaths: [...agent.touchedPaths],
    recentSymbols: [...agent.recentSymbols],
    terms: [...agent.terms],
    fingerprint: {
      revision: agent.fingerprint.revision,
      paths: agent.fingerprint.paths.map((signal) => ({ ...signal })),
      symbols: agent.fingerprint.symbols.map((signal) => ({ ...signal })),
      terms: agent.fingerprint.terms.map((signal) => ({ ...signal })),
    },
    stalePaths: [...agent.stalePaths],
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}
