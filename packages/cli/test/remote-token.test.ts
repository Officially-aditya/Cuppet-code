import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { test } from 'node:test'
import { verifyRemoteToken } from '../src/remote/token.js'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')

function token(payload: Record<string, unknown>): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = encode({ alg: 'EdDSA', typ: 'JWT' })
  const body = encode(payload)
  const signature = sign(null, Buffer.from(`${header}.${body}`), privateKey).toString('base64url')
  return `${header}.${body}.${signature}`
}

test('host verifies backend remote tokens and maps their scopes', () => {
  const value = verifyRemoteToken(
    token({
      iss: 'cuppet-backend',
      aud: 'cuppet-relay',
      sub: 'user_1',
      device: 'dev_1',
      host: 'host_1',
      scopes: ['sessions:read', 'permissions:reply', 'models:write'],
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
    publicKeyBase64,
    'host_1',
    'dev_1',
  )
  assert.deepEqual(value?.scopes, ['session.read', 'permission.write', 'model.write'])
  const now = Math.floor(Date.now() / 1000)
  assert.ok((value?.expiresAt ?? 0) >= now + 299)
  assert.ok((value?.expiresAt ?? 0) <= now + 300)
})

test('host rejects tampered, expired, or differently bound remote tokens', () => {
  const payload = {
    iss: 'cuppet-backend',
    aud: 'cuppet-relay',
    sub: 'user_1',
    device: 'dev_1',
    host: 'host_1',
    scopes: ['sessions:read'],
    exp: Math.floor(Date.now() / 1000) - 1,
  }
  const signed = token(payload)
  assert.equal(verifyRemoteToken(signed, publicKeyBase64, 'host_1', 'dev_1'), undefined)
  assert.equal(verifyRemoteToken(`${signed}x`, publicKeyBase64, 'host_1', 'dev_1'), undefined)
  const valid = token({ ...payload, exp: Math.floor(Date.now() / 1000) + 300 })
  assert.equal(verifyRemoteToken(valid, publicKeyBase64, 'host_2', 'dev_1'), undefined)
  assert.equal(verifyRemoteToken(valid, 'not-a-public-key', 'host_1', 'dev_1'), undefined)
})
