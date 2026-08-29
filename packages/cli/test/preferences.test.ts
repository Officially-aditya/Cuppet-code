import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PreferenceStore } from '../src/config/preferences.js'

test('preferences persist model references but no credential material', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cuppet-preferences-'))
  const path = join(directory, 'preferences.json')
  const store = new PreferenceStore(path)
  await store.load()
  await store.update({
    provider: 'openai',
    primary: { providerID: 'test', modelID: 'primary' },
    secondary: { providerID: 'test', modelID: 'secondary' },
    vertexProject: 'sydney-499116',
  })
  const content = await readFile(path, 'utf8')
  assert.match(content, /"provider": "openai"/)
  assert.match(content, /"providerID": "test"/)
  assert.match(content, /"vertexProject": "sydney-499116"/)
  assert.doesNotMatch(content, /api.?key|access.?token|refresh.?token|password/i)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
})

test('legacy platform preferences migrate to an unconstrained provider and are rewritten canonically', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cuppet-preferences-migration-'))
  const path = join(directory, 'preferences.json')
  await writeFile(path, JSON.stringify({
    schema: 1,
    platform: 'vertex',
    primary: { providerID: 'vertex', modelID: 'primary' },
    secondary: { providerID: 'vertex', modelID: 'secondary' },
  }))

  const store = new PreferenceStore(path)
  const value = await store.load()

  assert.equal(value.provider, 'vertex')
  assert.deepEqual(value.primary, { providerID: 'google-vertex', modelID: 'primary' })
  assert.deepEqual(value.secondary, { providerID: 'google-vertex', modelID: 'secondary' })
  assert.equal(value.platform, undefined)
  const content = await readFile(path, 'utf8')
  assert.match(content, /"provider": "vertex"/)
  assert.match(content, /"providerID": "google-vertex"/)
  assert.doesNotMatch(content, /"platform"/)
})

test('unknown live provider IDs are accepted by preference parsing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cuppet-preferences-provider-'))
  const store = new PreferenceStore(join(directory, 'preferences.json'))
  await store.load()

  const value = await store.update({ provider: 'acme-ai' })

  assert.equal(value.provider, 'acme-ai')
})
