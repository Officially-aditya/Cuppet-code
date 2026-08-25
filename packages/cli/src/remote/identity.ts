import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'

/**
 * Durable machine identity for remote control. Unlike the launch-scoped
 * runtime directory, this lives under ~/.cuppet/v2/remote and survives
 * restarts so relays and paired devices can recognize this host.
 */
export type HostIdentity = {
  hostId: string
  deviceName: string
  publicKeyPem: string
  privateKeyPem: string
  relaySecret: string
  createdAt: string
}

const IDENTITY_VERSION = 2

export function hostIdentityPath(remoteDir: string): string {
  return join(remoteDir, 'host.json')
}

export async function ensureHostIdentity(remoteDir: string): Promise<HostIdentity> {
  const path = hostIdentityPath(remoteDir)
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    if (
      typeof parsed.hostId === 'string' &&
      typeof parsed.publicKeyPem === 'string' &&
      typeof parsed.privateKeyPem === 'string'
    ) {
      const identity: HostIdentity = {
        hostId: parsed.hostId,
        deviceName: typeof parsed.deviceName === 'string' ? parsed.deviceName : hostname(),
        publicKeyPem: parsed.publicKeyPem,
        privateKeyPem: parsed.privateKeyPem,
        relaySecret: typeof parsed.relaySecret === 'string' && parsed.relaySecret.length >= 32
          ? parsed.relaySecret
          : randomBytes(32).toString('hex'),
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date().toISOString(),
      }
      if (parsed.relaySecret !== identity.relaySecret) await writeIdentity(path, identity)
      return identity
    }
  } catch {
    // First run on this machine: fall through and create the identity.
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const identity: HostIdentity = {
    hostId: `host_${randomBytes(8).toString('hex')}`,
    deviceName: hostname(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    relaySecret: randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString(),
  }
  await writeIdentity(path, identity)
  return identity
}

async function writeIdentity(path: string, identity: HostIdentity): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  await writeFile(
    path,
    `${JSON.stringify({ version: IDENTITY_VERSION, ...identity }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
  await chmod(path, 0o600)
}

export async function loadHostIdentityOrNull(remoteDir: string): Promise<HostIdentity | undefined> {
  try {
    return await ensureHostIdentity(remoteDir)
  } catch {
    return undefined
  }
}
