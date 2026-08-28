import type { HostIdentity } from './identity.js'
import { renderTerminalQr } from './qr.js'

export type RemoteSetupOptions = {
  apiBase: string
  identity: HostIdentity
  displayName?: string
  write?: (line: string) => void
  fetcher?: typeof fetch
  timeoutMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
  onSetup?: (setup: RemoteSetupPrompt) => void
}

export type RemoteSetupPrompt = {
  code: string
  url: string
  expiresAt: string
  qr?: string
}

export type RemoteSetupEnrollment = {
  relayUrl: string
  relayRegistered: boolean
  remoteTokenPublicKey?: string
}

type RemoteSetupSession = {
  setupId: string
  setupCode: string
  pollSecret: string
  setupUrl: string
  hostId: string
  displayName: string
  platform: string
  expiresAt: string
}

/**
 * Links a new Cuppet-code installation to the signed-in Cuppet app without
 * putting a user session token or relay secret in the QR code.
 */
export async function runRemoteSetup(
  options: RemoteSetupOptions,
): Promise<RemoteSetupEnrollment> {
  if (!/^https?:\/\//.test(options.apiBase)) {
    throw new Error(`--api-base must be an http(s) URL, got ${options.apiBase}`)
  }

  const fetcher = options.fetcher ?? fetch
  const session = await createSetupSession(options, fetcher)
  session.setupUrl = addApiBase(session.setupUrl, options.apiBase)
  const write = options.write ?? ((line: string) => process.stdout.write(line))
  write('  Cuppet setup — scan this QR in the signed-in Cuppet app\n')
  write(`  ${session.setupUrl}\n`)
  const qr = await renderTerminalQr(session.setupUrl)
  options.onSetup?.({
    code: session.setupCode,
    url: session.setupUrl,
    expiresAt: session.expiresAt,
    ...(qr ? { qr } : {}),
  })
  if (qr) write(`${qr}\n`)
  write(`  waiting for approval (${new Date(session.expiresAt).toISOString()})…\n`)

  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000)
  const pollIntervalMs = options.pollIntervalMs ?? 1500
  while (Date.now() < deadline) {
    const status = await requestSetupStatus(options, session, fetcher)
    if (status.status === 'expired') {
      throw new Error('The Cuppet setup QR expired. Run remote control again to create a new one.')
    }
    if (status.status === 'approved') {
      return await claimSetup(options, session, fetcher)
    }
    await wait(pollIntervalMs, options.signal)
  }
  throw new Error('Timed out waiting for Cuppet approval. Run remote control again to create a new QR.')
}

async function createSetupSession(
  options: RemoteSetupOptions,
  fetcher: typeof fetch,
): Promise<RemoteSetupSession> {
  const response = await fetcher(`${options.apiBase.replace(/\/$/, '')}/remote/setup/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      hostId: options.identity.hostId,
      displayName: options.displayName?.trim() || options.identity.deviceName,
      platform: process.platform,
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const payload = await readPayload(response)
  if (!response.ok) throw new Error(`Remote setup failed (${response.status}): ${errorMessage(payload)}`)
  if (
    typeof payload.setupId !== 'string' ||
    typeof payload.setupCode !== 'string' ||
    typeof payload.pollSecret !== 'string' ||
    typeof payload.setupUrl !== 'string'
  ) {
    throw new Error('Remote setup returned an invalid session.')
  }
  return payload as unknown as RemoteSetupSession
}

async function requestSetupStatus(
  options: RemoteSetupOptions,
  session: RemoteSetupSession,
  fetcher: typeof fetch,
): Promise<{ status: 'pending' | 'approved' | 'claimed' | 'expired' }> {
  const response = await fetcher(
    `${options.apiBase.replace(/\/$/, '')}/remote/setup/sessions/${encodeURIComponent(session.setupId)}/status`,
    {
      headers: { authorization: `Bearer ${session.pollSecret}` },
      ...(options.signal ? { signal: options.signal } : {}),
    },
  )
  const payload = await readPayload(response)
  if (!response.ok) throw new Error(`Remote setup status failed (${response.status}): ${errorMessage(payload)}`)
  const status = payload.status
  if (status !== 'pending' && status !== 'approved' && status !== 'claimed' && status !== 'expired') {
    throw new Error('Remote setup returned an invalid status.')
  }
  return { status }
}

async function claimSetup(
  options: RemoteSetupOptions,
  session: RemoteSetupSession,
  fetcher: typeof fetch,
): Promise<RemoteSetupEnrollment> {
  const response = await fetcher(
    `${options.apiBase.replace(/\/$/, '')}/remote/setup/sessions/${encodeURIComponent(session.setupId)}/claim`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${session.pollSecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ relaySecret: options.identity.relaySecret }),
      ...(options.signal ? { signal: options.signal } : {}),
    },
  )
  const payload = await readPayload(response)
  if (!response.ok) throw new Error(`Remote setup claim failed (${response.status}): ${errorMessage(payload)}`)
  if (typeof payload.relayUrl !== 'string' || payload.relayUrl.length === 0 || payload.relayRegistered !== true) {
    throw new Error('Remote setup did not return a registered relay.')
  }
  return {
    relayUrl: payload.relayUrl,
    relayRegistered: true,
    ...(typeof payload.remoteTokenPublicKey === 'string'
      ? { remoteTokenPublicKey: payload.remoteTokenPublicKey }
      : {}),
  }
}

async function readPayload(response: Response): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => ({}))
  return payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
}

function errorMessage(payload: Record<string, unknown>): string {
  const error = payload.error
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  return 'unexpected server response'
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Remote setup cancelled.'))
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds)
    const onAbort = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.reason ?? new Error('Remote setup cancelled.'))
    }
    function done() {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function addApiBase(setupUrl: string, apiBase: string): string {
  const url = new URL(setupUrl)
  url.searchParams.set('api', apiBase.replace(/\/$/, ''))
  return url.toString()
}
