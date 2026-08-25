import { createPublicKey, verify as verifySignature } from 'node:crypto'
import type { RemoteScope } from './protocol.js'

const BACKEND_SCOPE_MAP: Record<string, RemoteScope> = {
  'sessions:read': 'session.read',
  'sessions:write': 'session.write',
  'permissions:reply': 'permission.write',
  'questions:reply': 'question.write',
  'models:write': 'model.write',
}

/**
 * Verify the optional short-lived credential minted by Sydney. The host does
 * this locally. The relay is only a trusted transport for the short-lived
 * token and does not verify or persist it.
 */
export function verifyRemoteToken(
  token: string,
  publicKey: string,
  expectedHostId: string,
  expectedDeviceId: string,
): { scopes: RemoteScope[]; expiresAt: number } | undefined {
  const parts = token.split('.')
  if (parts.length !== 3 || !publicKey) return undefined
  const [encodedHeader, encodedPayload, encodedSignature] = parts
  if (!encodedHeader || !encodedPayload || !encodedSignature) return undefined

  try {
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as Record<string, unknown>
    if (header.alg !== 'EdDSA' || header.typ !== 'JWT') return undefined

    const key = createPublicKey({
      key: Buffer.from(publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    })
    if (key.asymmetricKeyType !== 'ed25519') return undefined
    const provided = Buffer.from(encodedSignature, 'base64url')
    if (!verifySignature(null, Buffer.from(`${encodedHeader}.${encodedPayload}`), key, provided)) return undefined

    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as Record<string, unknown>
    const now = Math.floor(Date.now() / 1000)
    if (
      payload.iss !== 'cuppet-backend' ||
      payload.aud !== 'cuppet-relay' ||
      typeof payload.sub !== 'string' ||
      payload.sub.length === 0 ||
      payload.host !== expectedHostId ||
      payload.device !== expectedDeviceId ||
      typeof payload.exp !== 'number' ||
      payload.exp <= now ||
      (typeof payload.iat === 'number' && payload.iat > now + 60)
    ) return undefined

    const scopes = Array.isArray(payload.scopes)
      ? payload.scopes
          .map((scope) => typeof scope === 'string' ? BACKEND_SCOPE_MAP[scope] : undefined)
          .filter((scope): scope is RemoteScope => scope !== undefined)
      : []
    return scopes.length > 0 ? { scopes: [...new Set(scopes)], expiresAt: payload.exp } : undefined
  } catch {
    return undefined
  }
}
