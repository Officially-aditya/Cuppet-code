import { CuppetControlClient } from './control.js'

type Pe3TuiApi = {
  route?: {
    current?: { name?: string; params?: Record<string, unknown> }
    navigate?(name: string, params?: Record<string, unknown>): void
  }
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
      const pe3 = record(status.pe3)
      const routing = record(pe3.routing)
      const sequence = numberValue(routing.sequence)
      if (sequence === undefined || sequence <= observedSequence) return
      observedSequence = sequence

      const action = stringValue(routing.lastAction)
      if (action !== 'create' && action !== 'reactivate') return
      const session = record(status.session)
      const targetSessionID = stringValue(session.id)
      if (!targetSessionID) return

      const current = api.route?.current
      const currentSessionID = typeof current?.params?.sessionID === 'string'
        ? current.params.sessionID
        : undefined
      if (current?.name !== 'session' || currentSessionID !== targetSessionID) {
        api.route?.navigate?.('session', { sessionID: targetSessionID })
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
