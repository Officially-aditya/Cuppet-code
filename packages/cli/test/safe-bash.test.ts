import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  isSafeAutoBashCommand,
  shouldAutoApproveBash,
  shouldAutoApproveWorkspacePermission,
} from '../src/opencode/safe-bash.js'

test('safe Bash auto mode permits only simple read-only workspace checks', () => {
  for (const command of [
    'pwd',
    'ls -la',
    'git status --short --branch',
    'git log -1 --oneline',
    'git branch --show-current',
    'git ls-files --cached',
    'git rev-parse --show-toplevel',
    'node --version',
  ]) assert.equal(isSafeAutoBashCommand(command), true, command)
})

test('safe Bash auto mode requires approval for shell syntax, paths, and executables', () => {
  for (const command of [
    'npm test',
    'git status && rm -rf /',
    'git status; rm -rf /',
    'git status | sh',
    'git status > /tmp/status',
    'git status $(whoami)',
    'rm -rf .',
    'cat .env',
    'cat ../.env',
    'ls /',
    'ls src',
    'rg TODO',
    'rg --files',
    'rg TODO ../outside',
    'git diff --stat',
    'git diff -- .env',
    'git diff -- /etc/passwd',
    'git log',
    'git log --all',
    'git remote -v',
    'git config --global user.name attacker',
    'bash -c echo',
    'git status --short src',
  ]) assert.equal(isSafeAutoBashCommand(command), false, command)
})

test('safe Bash auto mode only applies to a single Bash permission resource', () => {
  assert.equal(shouldAutoApproveBash({
    id: 'safe',
    sessionID: 'session',
    action: 'bash',
    resources: ['git status'],
  }), true)
  assert.equal(shouldAutoApproveBash({
    id: 'wrong-action',
    sessionID: 'session',
    action: 'edit',
    resources: ['git status'],
  }), false)
  assert.equal(shouldAutoApproveBash({
    id: 'multiple-resources',
    sessionID: 'session',
    action: 'bash',
    resources: ['git status', 'rm -rf /'],
  }), false)
})

test('workspace auto mode allows ordinary workspace files but preserves protected and external boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-safe-auto-'))
  const outside = await mkdtemp(join(tmpdir(), 'cuppet-safe-auto-outside-'))
  try {
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'app.ts'), 'export {}\n')
    await writeFile(join(root, '.env'), 'SECRET=value\n')
    await symlink(outside, join(root, 'outside-link'))

    assert.equal(await shouldAutoApproveWorkspacePermission({
      id: 'read', sessionID: 'session', action: 'read', resources: ['src/app.ts'],
    }, root), true)
    assert.equal(await shouldAutoApproveWorkspacePermission({
      id: 'write', sessionID: 'session', action: 'write', resources: ['src/new.ts'],
    }, root), true)
    for (const request of [
      { id: 'env', sessionID: 'session', action: 'edit', resources: ['.env'] },
      { id: 'credentials', sessionID: 'session', action: 'read', resources: ['src/credentials.pem'] },
      { id: 'outside', sessionID: 'session', action: 'write', resources: [join(outside, 'escape.ts')] },
      { id: 'symlink', sessionID: 'session', action: 'write', resources: ['outside-link/escape.ts'] },
      { id: 'glob', sessionID: 'session', action: 'edit', resources: ['src/*.ts'] },
      { id: 'external', sessionID: 'session', action: 'external_directory', resources: [outside] },
    ]) assert.equal(await shouldAutoApproveWorkspacePermission(request, root), false, request.id)
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })])
  }
})
