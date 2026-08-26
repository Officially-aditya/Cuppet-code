import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSafeAutoBashCommand, shouldAutoApproveBash } from '../src/opencode/safe-bash.js'

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
