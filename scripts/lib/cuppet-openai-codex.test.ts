import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDshOpenAICodexCredentialDocument } from './cuppet-openai-codex.js'

test('maps Cuppet OpenAI OAuth grants to the Harness Codex credential record', () => {
  assert.deepEqual(buildDshOpenAICodexCredentialDocument({
    type: 'oauth',
    access: 'access-token',
    refresh: 'refresh-token',
    expires: 1_800_000_000_000,
    accountId: 'account-id',
  }), {
    version: 1,
    records: {
      'llm-pi-ai/openai-codex': {
        kind: 'grant',
        payload: {
          type: 'oauth',
          access: 'access-token',
          refresh: 'refresh-token',
          expires: 1_800_000_000_000,
          accountId: 'account-id',
        },
      },
    },
  })
})

test('rejects an API key where the Codex OAuth grant is required', () => {
  assert.throws(
    () => buildDshOpenAICodexCredentialDocument({ type: 'api', key: 'not-oauth' }),
    /usable OAuth grant/,
  )
})
