import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { ensureHostIdentity } from '../src/remote/identity.js'
import { runRemoteSetup } from '../src/remote/setup.js'

test('remote setup prints only the QR payload and claims after mobile approval', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.remote-setup-test-'))
  try {
    const identity = await ensureHostIdentity(dir)
    const pollSecret = 'poll-secret-never-in-qr'
    const relaySecret = identity.relaySecret
    const calls: Array<{ url: string; init?: RequestInit }> = []
    let statusCalls = 0
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), ...(init ? { init } : {}) })
      if (String(input).endsWith('/remote/setup/sessions')) {
        return new Response(JSON.stringify({
          setupId: 'setup_0123456789abcdef0123456789abcdef',
          setupCode: 'ABC-123-xyz',
          pollSecret,
          setupUrl: 'cuppet://remote/setup?session=setup_0123456789abcdef0123456789abcdef&code=ABC-123-xyz',
          hostId: identity.hostId,
          displayName: identity.deviceName,
          platform: 'darwin',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }), { status: 200 })
      }
      if (String(input).endsWith('/status')) {
        statusCalls += 1
        return new Response(JSON.stringify({ status: statusCalls === 1 ? 'pending' : 'approved' }), { status: 200 })
      }
      if (String(input).endsWith('/claim')) {
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${pollSecret}`)
        assert.deepEqual(JSON.parse(String(init?.body)), { relaySecret })
        return new Response(JSON.stringify({
          relayUrl: 'wss://relay.example.test',
          relayRegistered: true,
        }), { status: 200 })
      }
      throw new Error(`unexpected URL ${String(input)}`)
    }

    const output: string[] = []
    const enrollment = await runRemoteSetup({
      apiBase: 'https://api.example.test',
      identity,
      fetcher,
      pollIntervalMs: 0,
      timeoutMs: 1000,
      write: (line) => output.push(line),
    })

    assert.equal(enrollment.relayUrl, 'wss://relay.example.test')
    assert.ok(output.some((line) => line.includes('cuppet://remote/setup')))
    assert.equal(output.some((line) => line.includes(pollSecret)), false)
    assert.equal(output.some((line) => line.includes(relaySecret)), false)
    assert.equal(calls.length, 4)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
