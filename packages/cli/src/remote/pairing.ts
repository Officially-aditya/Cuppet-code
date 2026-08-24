import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { DEFAULT_DEVICE_SCOPES, VIEWER_DEVICE_SCOPES, type RemoteScope } from './protocol.js'

/**
 * Host-side device registry and pairing invitations. The relay transports
 * bytes; it never learns device credentials — the host is the authority for
 * which devices exist, what they may do, and when they are revoked.
 */

export type PairingInvite = {
  code: string
  createdAt: number
  expiresAt: number
  role: 'trusted' | 'viewer'
}

export type PairedDevice = {
  deviceId: string
  name: string
  secretHash: string
  scopes: RemoteScope[]
  createdAt: number
}

/** Normalize either a relay origin or an existing /ws URL for host dialing. */
export function relayWebSocketUrl(relayUrl: string): string {
  const url = new URL(relayUrl)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('relay URL must use http(s) or ws(s)')
  }
  url.pathname = '/ws'
  url.search = ''
  url.hash = ''
  return url.toString()
}

const INVITE_TTL_MS = 2 * 60_000

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export async function createPairingInvite(
  remoteDir: string,
  options: { role?: 'trusted' | 'viewer'; ttlMs?: number; relayUrl?: string; hostId?: string } = {},
): Promise<PairingInvite & { url: string | undefined }> {
  const invite: PairingInvite = {
    code: randomBytes(6).toString('base64url').toUpperCase(),
    createdAt: Date.now(),
    expiresAt: Date.now() + (options.ttlMs ?? INVITE_TTL_MS),
    role: options.role ?? 'trusted',
  }
  await mkdir(join(remoteDir, 'pending'), { recursive: true, mode: 0o700 })
  await sweepExpiredInvites(remoteDir)
  await writeFile(
    join(remoteDir, 'pending', `${invite.code}.json`),
    JSON.stringify(invite),
    { encoding: 'utf8', mode: 0o600 },
  )
  let url: string | undefined
  if (options.relayUrl) {
    const params = new URLSearchParams({ code: invite.code })
    if (options.hostId) params.set('host', options.hostId)
    // The relay serves the PWA under /app. Pairing URLs are opened in a
    // browser, so translate the WebSocket scheme used by the host into the
    // corresponding HTTP scheme for the page.
    const page = new URL(options.relayUrl)
    if (page.protocol === 'wss:') page.protocol = 'https:'
    else if (page.protocol === 'ws:') page.protocol = 'http:'
    if (page.protocol !== 'http:' && page.protocol !== 'https:') {
      throw new Error('relay URL must use http(s) or ws(s)')
    }
    page.pathname = '/app'
    page.search = params.toString()
    page.hash = ''
    url = page.toString()
  }
  return { ...invite, url }
}

/** Pending invites are single-use and short-lived; never let them accumulate. */
async function sweepExpiredInvites(remoteDir: string): Promise<void> {
  try {
    const { readdir } = await import('node:fs/promises')
    const pendingDir = join(remoteDir, 'pending')
    const files = (await readdir(pendingDir)).filter((file) => file.endsWith('.json'))
    await Promise.all(files.map(async (file) => {
      try {
        const parsed = JSON.parse(await readFile(join(pendingDir, file), 'utf8')) as PairingInvite
        if (typeof parsed.expiresAt !== 'number' || parsed.expiresAt < Date.now()) {
          await rm(join(pendingDir, file), { force: true })
        }
      } catch {
        await rm(join(pendingDir, file), { force: true })
      }
    }))
  } catch {
    // best effort
  }
}

async function readInviteFile(path: string): Promise<PairingInvite | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as PairingInvite
    if (typeof parsed.code !== 'string' || typeof parsed.expiresAt !== 'number') return undefined
    return parsed
  } catch {
    return undefined
  }
}

/**
 * Redeem a pairing code: creates a device credential and consumes the invite.
 *
 * The rename IS the claim: POSIX rename is atomic and fails with ENOENT once
 * the source is gone, so exactly one concurrent claim can win. (unlink/rm are
 * NOT safe barriers here — Node's rm() swallows ENOENT, so two racing claims
 * can both observe success.)
 */
export async function claimPairingInvite(
  remoteDir: string,
  code: string,
  deviceName: string,
): Promise<{ deviceId: string; secret: string; scopes: RemoteScope[]; name: string } | undefined> {
  if (!/^[A-Za-z0-9_-]+$/.test(code)) return undefined
  const { rename } = await import('node:fs/promises')
  const invitePath = join(remoteDir, 'pending', `${code}.json`)
  const claimedPath = `${invitePath}.${randomBytes(6).toString('hex')}.claiming`
  try {
    await rename(invitePath, claimedPath)
  } catch {
    // Already claimed (or never existed).
    return undefined
  }
  try {
    const invite = await readInviteFile(claimedPath)
    if (!invite || invite.code !== code || invite.expiresAt < Date.now()) return undefined
    const deviceId = `dev_${randomBytes(8).toString('hex')}`
    const secret = randomBytes(32).toString('base64url')
    const device: PairedDevice = {
      deviceId,
      name: deviceName.slice(0, 64) || 'unnamed device',
      secretHash: sha256(secret),
      scopes: invite.role === 'viewer' ? VIEWER_DEVICE_SCOPES : DEFAULT_DEVICE_SCOPES,
      createdAt: Date.now(),
    }
    await mkdir(join(remoteDir, 'devices'), { recursive: true, mode: 0o700 })
    await writeFile(
      join(remoteDir, 'devices', `${deviceId}.json`),
      JSON.stringify(device),
      { encoding: 'utf8', mode: 0o600 },
    )
    return { deviceId, secret, scopes: device.scopes, name: device.name }
  } finally {
    // The invite is consumed either way; the claimed marker is dead weight.
    await rm(claimedPath, { force: true }).catch(() => undefined)
  }
}

export async function listPairedDevices(remoteDir: string): Promise<Array<Omit<PairedDevice, 'secretHash'>>> {
  try {
    const { readdir } = await import('node:fs/promises')
    const files = await readdir(join(remoteDir, 'devices'))
    const devices = await Promise.all(
      files.filter((file) => file.endsWith('.json')).map(async (file) => {
        try {
          const parsed = JSON.parse(await readFile(join(remoteDir, 'devices', file), 'utf8')) as PairedDevice
          return { deviceId: parsed.deviceId, name: parsed.name, scopes: parsed.scopes, createdAt: parsed.createdAt }
        } catch {
          return undefined
        }
      }),
    )
    return devices.filter((device): device is NonNullable<typeof device> => Boolean(device))
  } catch {
    return []
  }
}

export async function revokeDevice(remoteDir: string, deviceId: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]+$/.test(deviceId)) return false
  let removed = false
  try {
    await rm(join(remoteDir, 'devices', `${deviceId}.json`))
    removed = true
  } catch {
    removed = false
  }
  return removed
}

/** Constant-time credential check used on every bridge connection. */
export async function authenticateDevice(
  remoteDir: string,
  deviceId: string,
  secret: string,
): Promise<{ scopes: RemoteScope[]; name: string } | undefined> {
  if (!/^[A-Za-z0-9_-]+$/.test(deviceId)) return undefined
  try {
    const parsed = JSON.parse(await readFile(join(remoteDir, 'devices', `${deviceId}.json`), 'utf8')) as PairedDevice
    const provided = Buffer.from(sha256(secret))
    const stored = Buffer.from(parsed.secretHash)
    if (provided.length !== stored.length || !timingSafeEqual(provided, stored)) return undefined
    return { scopes: parsed.scopes, name: parsed.name }
  } catch {
    return undefined
  }
}
