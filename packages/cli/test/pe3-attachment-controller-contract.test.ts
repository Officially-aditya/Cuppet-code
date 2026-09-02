import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('native attachment routing is decision-only inside the PE3 controller', async () => {
  const source = await readFile('packages/cli/src/pe3/controller.ts', 'utf8')
  const start = source.indexOf('  async routeNativePrompt(')
  const end = source.indexOf('  override async status()', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const method = source.slice(start, end)

  assert.match(method, /nativeRoutingPrompt\(prompt, attachments\)/)
  assert.match(method, /targetSessionID: prepared\.sessionID/)
  assert.match(method, /Do not submit here/)
  assert.doesNotMatch(method, /super\.submit\(/)
  assert.doesNotMatch(method, /gateway\.prompt\(/)
})
