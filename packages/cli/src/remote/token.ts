import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { RemoteScope } from './protocol.js'

const BACKEND_SCOPE_MAP: Record<string, RemoteScope> = {
  'sessions:read': 'session.read',
  'sessions:write': 'session.write',
  'permissions:reply': 'permission.write',
  'questions:reply': 'question.write',
}

/**
 * Verify the optional short-lived credential minted by Sydney. The host does
 * this locally; the backend secret and the token never reach the relay.
 */
export function verifyRemoteToken(
  token: string,
  secret: string,
  expectedHostId: string,
  expectedDeviceId: string,
): { scopes: RemoteScope[] } | undefined {
  const parts = token.split('.')
  if (parts.length !== 3 || !secret) return undefined
  const [encodedHeader, encodedPayload, encodedSignature] = parts
  if (!encodedHeader || !encodedPayload || !encodedSignature) return undefined

  try {
    const header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as Record<string, unknown>
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return undefined

    const key = createHash('sha256').update(`cuppet-remote-v1:${secret}`).digest()
    const expected = createHmac('sha256', key)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest()
    const provided = Buffer.from(encodedSignature, 'base64url')
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return undefined

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
    return scopes.length > 0 ? { scopes: [...new Set(scopes)] } : undefined
  } catch {
    return undefined
  }
}
