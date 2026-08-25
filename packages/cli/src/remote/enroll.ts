import { hostname } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensureHostIdentity } from './identity.js'

export type EnrollArguments = {
  apiBase: string
  token?: string
  name?: string
}

export type RegisterHostOptions = {
  apiBase: string
  token: string
  identity: Awaited<ReturnType<typeof ensureHostIdentity>>
  relaySecret: string
  displayName?: string
  fetcher?: typeof fetch
}

export type HostEnrollment = {
  relayUrl?: string
  relayRegistered: boolean
}

export async function registerHost(options: RegisterHostOptions): Promise<HostEnrollment> {
  if (!/^https?:\/\//.test(options.apiBase)) {
    throw new Error(`--api-base must be an http(s) URL, got ${options.apiBase}`)
  }
  if (options.relaySecret.length < 32) {
    throw new Error('relay secret must be at least 32 characters')
  }

  const fetcher = options.fetcher ?? fetch
  const response = await fetcher(`${options.apiBase.replace(/\/$/, '')}/remote/hosts`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      hostId: options.identity.hostId,
      displayName: options.displayName?.trim() || options.identity.deviceName || hostname(),
      platform: process.platform,
      relaySecret: options.relaySecret,
    })
  })

  if (response.status === 409) {
    throw new Error('This machine is already registered to a different Cuppet account.')
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Enrollment failed (${response.status}): ${body.slice(0, 300) || response.statusText}`)
  }

  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  return {
    ...(typeof payload.relayUrl === 'string' ? { relayUrl: payload.relayUrl } : {}),
    relayRegistered: payload.relayRegistered === true,
  }
}

/**
 * `cuppet remote-enroll` — registers this machine with the user's Cuppet
 * account so the mobile Coding agent can discover it. Uses the same JWT the
 * app authenticates with; the relay secret is sent only over this authenticated
 * request so Sydney can register its hash with the relay.
 */
export async function runEnroll(
  options: EnrollArguments,
  write: (line: string) => void = (line) => process.stdout.write(line),
): Promise<void> {
  if (!options.token) {
    throw new Error('A Cuppet session token is required for enrollment (use the --token flag or set CUPPET_TOKEN)')
  }
  if (!/^https?:\/\//.test(options.apiBase)) {
    throw new Error(`--api-base must be an http(s) URL, got ${options.apiBase}`)
  }

  const identity = await ensureHostIdentity(join(homedir(), '.cuppet', 'v2', 'remote'))
  const displayName = options.name?.trim() || identity.deviceName || hostname()
  const enrollment = await registerHost({
    apiBase: options.apiBase,
    token: options.token,
    identity,
    relaySecret: identity.relaySecret,
    displayName,
  })

  write(`Enrolled ${displayName} [${identity.hostId}] with ${options.apiBase}\n`)
  if (enrollment.relayUrl) write(`Relay: ${enrollment.relayUrl}${enrollment.relayRegistered ? ' (registered)' : ''}\n`)
  write('Start coding remotely with:\n')
  write('  cuppet remote-control\n')
}
