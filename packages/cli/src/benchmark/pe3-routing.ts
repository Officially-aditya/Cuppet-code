import { TaskSessionRouter, type TaskSessionAdapter } from '../pe3/session-router.js'

export type Pe3BenchmarkArm = 'current' | 'pe3_no_routing' | 'oracle' | 'detected'

export type Pe3TurnOutcome = {
  success?: boolean
  firstPassSuccess?: boolean
  retries?: number
  staleContextIncident?: boolean
  cachedInput?: number
  uncachedInput?: number
  outputTokens?: number
  effectiveCost?: number
  latencyMs?: number
}

export type Pe3BenchmarkTurn = {
  taskID: string
  prompt: string
  outcome?: Pe3TurnOutcome
}

export type Pe3SemanticTrace = {
  modelID?: string
  activeSimilarity?: number
  bestDormantSimilarity?: number
  embeddingLatencyMs: number
}

export type Pe3BenchmarkTurnResult = {
  index: number
  taskID: string
  prompt: string
  sessionID: string
  action: 'continue' | 'create' | 'reactivate'
  expectedSwitch: boolean
  actualSwitch: boolean
  falseSplit: boolean
  missedSwitch: boolean
  semanticEscalated: boolean
  semantic?: Pe3SemanticTrace
  outcome: Required<Pe3TurnOutcome>
}

export type Pe3BenchmarkResult = {
  arm: Pe3BenchmarkArm
  turns: Pe3BenchmarkTurnResult[]
  metrics: {
    taskSuccessRate: number
    firstPassSuccessRate: number
    retries: number
    staleContextIncidents: number
    cachedInput: number
    uncachedInput: number
    outputTokens: number
    providerAdjustedEffectiveCost: number
    latencyMs: number
    unnecessaryAgentSwitches: number
    missedTaskSwitches: number
    agentSwitches: number
    cacheReuseRatio: number
    semanticEscalations: number
    semanticEmbeddingLatencyMs: number
  }
}

export type Pe3BenchmarkOptions = {
  /** Injectable detected router lets calibration runs compare embedding models. */
  detectedRouter?: TaskSessionRouter
}

export type Pe3SemanticCalibrationRow = {
  index: number
  taskID: string
  expectedSwitch: boolean
  actualSwitch: boolean
  falseSplit: boolean
  missedSwitch: boolean
  activeSimilarity?: number
  bestDormantSimilarity?: number
  dormantActiveMargin?: number
  embeddingLatencyMs: number
  modelID?: string
}

/**
 * Evaluate task-boundary behavior independently from model quality.
 *
 * Live/provider benchmark runners can attach real per-turn outcomes; unit and
 * routing benchmarks can omit them and still measure switch precision/recall.
 */
export async function runPe3BenchmarkArm(
  arm: Pe3BenchmarkArm,
  turns: Pe3BenchmarkTurn[],
  options: Pe3BenchmarkOptions = {},
): Promise<Pe3BenchmarkResult> {
  const detected = arm === 'detected' ? options.detectedRouter ?? new TaskSessionRouter() : undefined
  const detectedHarness = detected ? adapterHarness() : undefined
  const oracleSessions = new Map<string, string>()
  let oracleCreated = 0
  const fixedSession = 'session-1'
  const results: Pe3BenchmarkTurnResult[] = []
  let previousTask: string | undefined
  let previousSession: string | undefined

  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]!
    const expectedSwitch = previousTask !== undefined && turn.taskID !== previousTask
    let sessionID: string
    let action: Pe3BenchmarkTurnResult['action']
    let semanticEscalated = false
    let semantic: Pe3SemanticTrace | undefined

    if (arm === 'current' || arm === 'pe3_no_routing') {
      sessionID = fixedSession
      action = index === 0 ? 'create' : 'continue'
    } else if (arm === 'oracle') {
      const existing = oracleSessions.get(turn.taskID)
      if (existing) {
        sessionID = existing
        action = previousSession === existing ? 'continue' : 'reactivate'
      } else {
        oracleCreated += 1
        sessionID = `oracle-${oracleCreated}`
        oracleSessions.set(turn.taskID, sessionID)
        action = 'create'
      }
    } else {
      const before = detected!.stats()
      const route = await detected!.prepare(turn.prompt, detectedHarness!.adapter)
      const after = detected!.stats()
      sessionID = route.sessionID
      action = route.action
      semanticEscalated = after.semanticEscalations > before.semanticEscalations
      if (semanticEscalated) {
        semantic = {
          ...(after.semanticModelID ? { modelID: after.semanticModelID } : {}),
          ...(after.lastSemanticActiveSimilarity !== undefined
            ? { activeSimilarity: after.lastSemanticActiveSimilarity }
            : {}),
          ...(after.lastSemanticDormantSimilarity !== undefined
            ? { bestDormantSimilarity: after.lastSemanticDormantSimilarity }
            : {}),
          embeddingLatencyMs: Math.max(0, after.semanticEmbeddingLatencyMs - before.semanticEmbeddingLatencyMs),
        }
      }
    }

    const actualSwitch = previousSession !== undefined && sessionID !== previousSession
    const falseSplit = previousTask !== undefined && turn.taskID === previousTask && actualSwitch
    const missedSwitch = expectedSwitch && !actualSwitch
    results.push({
      index,
      taskID: turn.taskID,
      prompt: turn.prompt,
      sessionID,
      action,
      expectedSwitch,
      actualSwitch,
      falseSplit,
      missedSwitch,
      semanticEscalated,
      ...(semantic ? { semantic } : {}),
      outcome: normalizeOutcome(turn.outcome),
    })
    previousTask = turn.taskID
    previousSession = sessionID
  }

  return { arm, turns: results, metrics: summarize(results) }
}

export async function runPe3Benchmark(
  turns: Pe3BenchmarkTurn[],
  options: Pe3BenchmarkOptions = {},
): Promise<Pe3BenchmarkResult[]> {
  return Promise.all(
    (['current', 'pe3_no_routing', 'oracle', 'detected'] as const)
      .map((arm) => runPe3BenchmarkArm(arm, turns, arm === 'detected' ? options : {})),
  )
}

/**
 * Compact rows suitable for Issue #4/offline threshold sweeps. No threshold is
 * learned in production; benchmark tooling can group these rows by ground-truth
 * task boundary and choose margins that minimize false splits first.
 */
export function semanticCalibrationRows(result: Pe3BenchmarkResult): Pe3SemanticCalibrationRow[] {
  return result.turns
    .filter((turn) => turn.semanticEscalated && turn.semantic)
    .map((turn) => {
      const active = turn.semantic?.activeSimilarity
      const dormant = turn.semantic?.bestDormantSimilarity
      return {
        index: turn.index,
        taskID: turn.taskID,
        expectedSwitch: turn.expectedSwitch,
        actualSwitch: turn.actualSwitch,
        falseSplit: turn.falseSplit,
        missedSwitch: turn.missedSwitch,
        ...(active !== undefined ? { activeSimilarity: active } : {}),
        ...(dormant !== undefined ? { bestDormantSimilarity: dormant } : {}),
        ...(active !== undefined && dormant !== undefined ? { dormantActiveMargin: dormant - active } : {}),
        embeddingLatencyMs: turn.semantic?.embeddingLatencyMs ?? 0,
        ...(turn.semantic?.modelID ? { modelID: turn.semantic.modelID } : {}),
      }
    })
}

function summarize(turns: Pe3BenchmarkTurnResult[]): Pe3BenchmarkResult['metrics'] {
  const outcomes = turns.map((turn) => turn.outcome)
  const successes = outcomes.filter((outcome) => outcome.success).length
  const firstPasses = outcomes.filter((outcome) => outcome.firstPassSuccess).length
  const cachedInput = sum(outcomes, 'cachedInput')
  const uncachedInput = sum(outcomes, 'uncachedInput')
  const totalInput = cachedInput + uncachedInput
  return {
    taskSuccessRate: turns.length > 0 ? successes / turns.length : 0,
    firstPassSuccessRate: turns.length > 0 ? firstPasses / turns.length : 0,
    retries: sum(outcomes, 'retries'),
    staleContextIncidents: outcomes.filter((outcome) => outcome.staleContextIncident).length,
    cachedInput,
    uncachedInput,
    outputTokens: sum(outcomes, 'outputTokens'),
    providerAdjustedEffectiveCost: sum(outcomes, 'effectiveCost'),
    latencyMs: sum(outcomes, 'latencyMs'),
    unnecessaryAgentSwitches: turns.filter((turn) => turn.falseSplit).length,
    missedTaskSwitches: turns.filter((turn) => turn.missedSwitch).length,
    agentSwitches: turns.filter((turn) => turn.actualSwitch).length,
    cacheReuseRatio: totalInput > 0 ? cachedInput / totalInput : 0,
    semanticEscalations: turns.filter((turn) => turn.semanticEscalated).length,
    semanticEmbeddingLatencyMs: turns.reduce((total, turn) => total + (turn.semantic?.embeddingLatencyMs ?? 0), 0),
  }
}

function normalizeOutcome(outcome: Pe3TurnOutcome | undefined): Required<Pe3TurnOutcome> {
  return {
    success: outcome?.success ?? false,
    firstPassSuccess: outcome?.firstPassSuccess ?? false,
    retries: boundedNumber(outcome?.retries),
    staleContextIncident: outcome?.staleContextIncident ?? false,
    cachedInput: boundedNumber(outcome?.cachedInput),
    uncachedInput: boundedNumber(outcome?.uncachedInput),
    outputTokens: boundedNumber(outcome?.outputTokens),
    effectiveCost: boundedNumber(outcome?.effectiveCost),
    latencyMs: boundedNumber(outcome?.latencyMs),
  }
}

function boundedNumber(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function sum(
  outcomes: Array<Required<Pe3TurnOutcome>>,
  key: 'retries' | 'cachedInput' | 'uncachedInput' | 'outputTokens' | 'effectiveCost' | 'latencyMs',
): number {
  return outcomes.reduce((total, outcome) => total + outcome[key], 0)
}

function adapterHarness(): { adapter: TaskSessionAdapter } {
  let currentID: string | undefined
  let created = 0
  return {
    adapter: {
      current: () => currentID ? { id: currentID } : undefined,
      create: async () => {
        created += 1
        currentID = `detected-${created}`
        return { id: currentID }
      },
      resume: async (sessionID) => {
        currentID = sessionID
        return { id: sessionID }
      },
      evidence: () => ({}),
    },
  }
}
