import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { redact } from '../src/runtime/logger.js'

test('runtime source contains no legacy credential import path', async () => {
  const sources = [
    'src/cli.tsx',
    'src/controller.ts',
    'src/runtime/paths.ts',
    'src/config/preferences.ts',
  ]
  const content = (
    await Promise.all(sources.map((source) => readFile(join(import.meta.dirname, '..', source), 'utf8')))
  ).join('\n')
  assert.doesNotMatch(content, /claude\.json|credentials\.json|ltm-trie\.json/)
})

test('OpenCode permissions permanently deny legacy credential records', async () => {
  const server = await readFile(join(import.meta.dirname, '..', 'src/opencode/server.ts'), 'utf8')
  for (const path of ['**/.claude.json', '**/.cuppet/credentials.json', '**/.cuppet/ltm-trie.json']) {
    assert.ok(server.includes(`'${path}': 'deny'`), `${path} must stay denied`)
  }
})

test('local diagnostics redact common bearer tokens', () => {
  assert.equal(redact('failed with sk-1234567890abcdefghijk'), 'failed with [REDACTED]')
  assert.equal(redact('Authorization: bearer-secret-value'), 'Authorization=[REDACTED]')
  assert.equal(redact('aws AKIAIOSFODNN7EXAMPLE'), 'aws [REDACTED]')
  assert.equal(
    redact('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjdXBwZXQifQ.signaturevalue'),
    'jwt [REDACTED]',
  )
})
