import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { test } from 'node:test'
import { verifyRemoteToken } from '../src/remote/token.js'

function token(secret: string, payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = encode({ alg: 'HS256', typ: 'JWT' })
  const body = encode(payload)
  const key = createHash('sha256').update(`cuppet-remote-v1:${secret}`).digest()
  const signature = createHmac('sha256', key).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${signature}`
}

test('host verifies backend remote tokens and maps their scopes', () => {
  const value = verifyRemoteToken(
    token('a'.repeat(32), {
      iss: 'cuppet-backend',
      aud: 'cuppet-relay',
      sub: 'user_1',
      device: 'dev_1',
      host: 'host_1',
      scopes: ['sessions:read', 'permissions:reply', 'models:write'],
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
    'a'.repeat(32),
    'host_1',
    'dev_1',
  )
  assert.deepEqual(value?.scopes, ['session.read', 'permission.write', 'model.write'])
  const now = Math.floor(Date.now() / 1000)
  assert.ok((value?.expiresAt ?? 0) >= now + 299)
  assert.ok((value?.expiresAt ?? 0) <= now + 300)
})

test('host rejects tampered, expired, or differently bound remote tokens', () => {
  const secret = 'b'.repeat(32)
  const payload = {
    iss: 'cuppet-backend',
    aud: 'cuppet-relay',
    sub: 'user_1',
    device: 'dev_1',
    host: 'host_1',
    scopes: ['sessions:read'],
    exp: Math.floor(Date.now() / 1000) - 1,
  }
  const signed = token(secret, payload)
  assert.equal(verifyRemoteToken(signed, secret, 'host_1', 'dev_1'), undefined)
  assert.equal(verifyRemoteToken(`${signed}x`, secret, 'host_1', 'dev_1'), undefined)
  const valid = token(secret, { ...payload, exp: Math.floor(Date.now() / 1000) + 300 })
  assert.equal(verifyRemoteToken(valid, secret, 'host_2', 'dev_1'), undefined)
})
