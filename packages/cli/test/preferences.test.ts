import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
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
    primary: { providerID: 'test', modelID: 'primary' },
    secondary: { providerID: 'test', modelID: 'secondary' },
  })
  const content = await readFile(path, 'utf8')
  assert.match(content, /"providerID": "test"/)
  assert.doesNotMatch(content, /api.?key|access.?token|refresh.?token|password/i)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
})
