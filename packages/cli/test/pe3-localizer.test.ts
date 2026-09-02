import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TstTaskLocalizer } from '../src/pe3/localizer.js'
import type { TstClient } from '../src/tst/client.js'

test('TST localizer keeps bounded high-confidence graph paths and symbols only', async () => {
  const client = {
    connected: true,
    call: async () => ({
      graph: [
        { score: 1, node: { path: 'src/auth/token.ts', name: 'refreshToken' } },
        { score: 0.8, node: { path: 'src/auth/oauth.ts', name: 'OAuthSession' } },
        { score: 0.2, node: { path: 'src/unrelated/noise.ts', name: 'Noise' } },
      ],
    }),
  } as unknown as TstClient

  const localized = await new TstTaskLocalizer(client).locate('s1', 'repair token renewal')

  assert.deepEqual(localized.localizedPaths, ['src/auth/token.ts', 'src/auth/oauth.ts'])
  assert.deepEqual(localized.localizedSymbols, ['refreshToken', 'OAuthSession'])
})

test('TST localizer degrades to no evidence on local query failure', async () => {
  const client = {
    connected: true,
    call: async () => {
      throw new Error('TST unavailable')
    },
  } as unknown as TstClient

  assert.deepEqual(await new TstTaskLocalizer(client).locate('s1', 'anything'), {})
})

test('TST localizer does not query disconnected runtime', async () => {
  let calls = 0
  const client = {
    connected: false,
    call: async () => {
      calls += 1
      return {}
    },
  } as unknown as TstClient

  assert.deepEqual(await new TstTaskLocalizer(client).locate('s1', 'anything'), {})
  assert.equal(calls, 0)
})
