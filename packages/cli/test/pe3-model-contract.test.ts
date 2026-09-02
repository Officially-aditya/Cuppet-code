import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('PE3 local embedding runtime is declared and routing code contains no remote inference client', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  assert.equal(pkg.dependencies?.['@huggingface/transformers'], '4.2.0')

  const source = await readFile(new URL('../src/pe3/local-embedding.ts', import.meta.url), 'utf8')
  assert.match(source, /feature-extraction/)
  assert.match(source, /allowRemoteModels/)
  assert.doesNotMatch(source, /fetch\s*\(/)
  assert.doesNotMatch(source, /https?:\/\//)
})
