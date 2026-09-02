import { CuppetControlClient } from './control.js'

type Pe3TuiRoute = {
  name?: string
  params?: Record<string, unknown>
}

type Pe3TuiApi = {
  route?: {
    current?: Pe3TuiRoute
    navigate?(name: string, params?: Record<string, unknown>): void
  }
}

export type Pe3TuiNavigationDecision = {
  observedSequence: number
  targetSessionID?: string
}

/**
 * Follow only newly-observed PE3 switch decisions.
 *
 * A monotonically increasing routing sequence prevents this poller from
 * fighting manual session navigation after the one intended handoff.
 */
export function installPe3TuiNavigation(api: Pe3TuiApi): void {
  if (!process.env.CUPPET_CONTROL_SOCKET || !process.env.CUPPET_CONTROL_TOKEN) return
  const client = new CuppetControlClient()
  let observedSequence = 0
  let running = false

  const sync = async () => {
    if (running) return
    running = true
    try {
      const status = await client.call<Record<string, unknown>>('status')
      const decision = pe3TuiNavigationDecision(status, api.route?.current, observedSequence)
      observedSequence = decision.observedSequence
      if (decision.targetSessionID) {
        api.route?.navigate?.('session', { sessionID: decision.targetSessionID })
      }
    } catch {
      // The base Cuppet TUI plugin owns user-visible control diagnostics. PE3
      // navigation is opportunistic and must never break the native TUI.
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void sync(), 200)
  if (typeof timer.unref === 'function') timer.unref()
  void sync()
}

export function pe3TuiNavigationDecision(
  status: Record<string, unknown>,
  current: Pe3TuiRoute | undefined,
  observedSequence: number,
): Pe3TuiNavigationDecision {
  const pe3 = record(status.pe3)
  const routing = record(pe3.routing)
  const sequence = numberValue(routing.sequence)
  if (sequence === undefined || sequence <= observedSequence) return { observedSequence }

  const decision: Pe3TuiNavigationDecision = { observedSequence: sequence }
  const action = stringValue(routing.lastAction)
  if (action !== 'create' && action !== 'reactivate') return decision

  const session = record(status.session)
  const targetSessionID = stringValue(session.id)
  if (!targetSessionID) return decision
  const currentSessionID = typeof current?.params?.sessionID === 'string'
    ? current.params.sessionID
    : undefined
  if (current?.name === 'session' && currentSessionID === targetSessionID) return decision
  return { ...decision, targetSessionID }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
