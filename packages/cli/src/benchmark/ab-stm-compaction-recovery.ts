export type RecoveryArm = 'control' | 'stm_only'

export type TrialIdentity = {
  repeat: number
  arm: RecoveryArm
}

/** Checkpoint boundaries at which an interrupted active arm is safe to retry. */
export const CHECKPOINT_BOUNDARIES = [
  'fixture.created',
  'runtime_created',
  'tst_created',
  'opencode_created',
  'session_created',
  'prompt_phase',
  'compaction.start',
  'compaction.completed',
  'stm_refresh_completed',
  'arm.finished',
] as const

export function trialPairKey(repeat: number, arm: RecoveryArm): string {
  return `${repeat}:${arm}`
}

export function completedPairKeys(trials: readonly TrialIdentity[]): Set<string> {
  return new Set(trials.map((trial) => trialPairKey(trial.repeat, trial.arm)))
}

export function pendingPairs(
  armOrders: readonly (readonly RecoveryArm[])[],
  completedTrials: readonly TrialIdentity[],
): Array<{ repeat: number; arm: RecoveryArm }> {
  const completed = completedPairKeys(completedTrials)
  return armOrders.flatMap((order, repeatIndex) => order
    .filter((arm) => !completed.has(trialPairKey(repeatIndex + 1, arm)))
    .map((arm) => ({ repeat: repeatIndex + 1, arm })))
}

export function validateCompletedPairs(
  trials: readonly TrialIdentity[],
  repeats: number,
): void {
  const seen = new Set<string>()
  for (const trial of trials) {
    if (!Number.isInteger(trial.repeat) || trial.repeat < 1 || trial.repeat > repeats) {
      throw new Error(`completed trial repeat is outside 1..${repeats}`)
    }
    if (trial.arm !== 'control' && trial.arm !== 'stm_only') {
      throw new Error(`completed trial arm is invalid: ${String(trial.arm)}`)
    }
    const key = trialPairKey(trial.repeat, trial.arm)
    if (seen.has(key)) throw new Error(`duplicate completed pair ${key}`)
    seen.add(key)
  }
}
