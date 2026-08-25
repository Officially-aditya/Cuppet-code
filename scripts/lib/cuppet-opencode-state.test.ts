import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveCuppetOpenCodeStateFiles } from './cuppet-opencode-state.js'

test('resolves the isolated OpenCode provider state files without exposing contents', () => {
  const files = resolveCuppetOpenCodeStateFiles('/persistent/opencode', {
    opencode: {
      data: '/runtime/data',
      cache: '/runtime/cache',
    },
  } as never)
  assert.deepEqual(files, [
    { source: '/persistent/opencode/data/opencode/auth.json', target: '/runtime/data/opencode/auth.json' },
    { source: '/persistent/opencode/data/opencode/opencode.db', target: '/runtime/data/opencode/opencode.db' },
    { source: '/persistent/opencode/data/opencode/opencode.db-wal', target: '/runtime/data/opencode/opencode.db-wal' },
    { source: '/persistent/opencode/data/opencode/opencode.db-shm', target: '/runtime/data/opencode/opencode.db-shm' },
    { source: '/persistent/opencode/cache/opencode/models.json', target: '/runtime/cache/opencode/models.json' },
  ])
})

