import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { refreshRuntimePlugins } from './runtime-plugin-sync.mjs'

test('global installer refreshes runtime plugins and their checksums', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-runtime-sync-'))
  const runtime = join(root, 'runtime')
  const plugin = join(root, 'plugin')
  try {
    await mkdir(join(runtime, 'plugin'), { recursive: true })
    await mkdir(plugin)
    await writeFile(join(runtime, 'manifest.json'), JSON.stringify({ files: { 'bin/opencode': 'unchanged' } }))
    for (const name of ['index.js', 'server.js', 'tui.js']) await writeFile(join(plugin, name), `current ${name}`)

    await refreshRuntimePlugins(runtime, plugin)

    const manifest = JSON.parse(await readFile(join(runtime, 'manifest.json'), 'utf8'))
    assert.equal(manifest.files['bin/opencode'], 'unchanged')
    for (const name of ['index.js', 'server.js', 'tui.js']) {
      const content = await readFile(join(runtime, 'plugin', name), 'utf8')
      assert.equal(content, `current ${name}`)
      assert.equal(manifest.files[`plugin/${name}`], createHash('sha256').update(content).digest('hex'))
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
