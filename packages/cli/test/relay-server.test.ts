import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_RELAY_BIND, resolveRelayBind } from '../src/remote/relay.js'
import {
  defaultRelayAuthPath,
  ensureRelayAuthFile,
  resolveRelayServerSecurity,
} from '../src/remote/relay-main.js'

test('relay defaults to loopback and creates a fail-closed auth registry', async () => {
  const security = resolveRelayServerSecurity({})
  assert.equal(security.bind, DEFAULT_RELAY_BIND)
  assert.equal(security.authFile, resolve(defaultRelayAuthPath()))
  assert.equal(resolveRelayBind(), DEFAULT_RELAY_BIND)
  assert.equal(resolveRelayBind('  0.0.0.0  '), '0.0.0.0')

  const directory = await mkdtemp(join(process.cwd(), '.relay-server-auth-'))
  const authFile = join(directory, 'auth.json')
  const output: string[] = []
  try {
    await ensureRelayAuthFile(authFile, (line) => output.push(line))
    assert.deepEqual(JSON.parse(await readFile(authFile, 'utf8')), { hosts: {} })
    assert.equal(output.length, 1)
    if (process.platform !== 'win32') {
      assert.equal((await stat(authFile)).mode & 0o777, 0o600)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
