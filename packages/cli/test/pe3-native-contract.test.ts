import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('PE3 derivative patch routes native text prompts before model inference', async () => {
  const patch = await readFile('patches/opencode/0016-cuppet-pe3-native-routing.patch', 'utf8')
  assert.match(patch, /routeCuppetNativePrompt/)
  assert.match(patch, /method: \"pe3\.route-native\"/)
  assert.match(patch, /noReply: true/)
  assert.match(patch, /textOnlyPrompt/)
  assert.match(patch, /MAX_PROMPT_BYTES/)
  assert.match(patch, /PE3 routed this request to task session/)
})
