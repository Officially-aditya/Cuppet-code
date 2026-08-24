import { hostname } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensureHostIdentity } from './identity.js'

export type EnrollArguments = {
  apiBase: string
  token?: string
  name?: string
}

/**
 * `cuppet remote-enroll` — registers this machine with the user's Cuppet
 * account so the mobile Coding agent can discover it. Uses the same JWT the
 * app authenticates with; the machine's relay secret never leaves the host.
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

  const response = await fetch(`${options.apiBase.replace(/\/$/, '')}/remote/hosts`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      hostId: identity.hostId,
      displayName,
      platform: process.platform
    })
  })

  if (response.status === 409) {
    throw new Error('This machine is already registered to a different Cuppet account.')
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Enrollment failed (${response.status}): ${body.slice(0, 300) || response.statusText}`)
  }

  write(`Enrolled ${displayName} [${identity.hostId}] with ${options.apiBase}\n`)
  write('Start coding remotely with:\n')
  write('  cuppet remote-control --relay-url <wss://…>\n')
}
