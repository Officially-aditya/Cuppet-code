import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { foregroundPermissions, GRAPH_NATIVE_TOOL_PROFILE } from '../src/opencode/server.js'
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

test('OpenCode permissions use real actions and ordered sensitive resource rules', () => {
  const permissions = foregroundPermissions()
  const read = permissions.read as Record<string, string>
  const edit = permissions.edit as Record<string, string>

  assert.equal(read['*'], 'allow')
  assert.equal(read['**/.env'], 'ask')
  assert.equal(read['**/.env.example'], 'allow')
  assert.equal(read['**/.claude.json'], 'deny')
  assert.equal(read['**/.cuppet/credentials.json'], 'deny')
  assert.equal(edit['*'], 'ask')
  assert.equal(edit['**/.claude.json'], 'deny')
  assert.equal('read_file' in permissions, false)
  assert.equal('write_file' in permissions, false)
  assert.equal(permissions.bash, 'ask')
})

test('graph-native profile removes legacy discovery tools from the agent action space', () => {
  const profile = GRAPH_NATIVE_TOOL_PROFILE as Record<string, boolean | undefined>
  assert.equal(GRAPH_NATIVE_TOOL_PROFILE['*'], false)
  for (const tool of ['read', 'edit', 'write', 'bash', 'todowrite', 'cuppet_plan', 'cuppet_graph_search', 'cuppet_graph_trace']) {
    assert.equal(profile[tool], true, `${tool} must remain available`)
  }
  for (const tool of ['glob', 'grep', 'lsp', 'webfetch', 'websearch', 'task']) {
    assert.equal(profile[tool], undefined, `${tool} must not be allowlisted`)
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
