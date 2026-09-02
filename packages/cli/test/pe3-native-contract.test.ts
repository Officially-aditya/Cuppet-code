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

test('PE3 derivative applies persisted stale-path refresh guard before same-session native inference', async () => {
  const patch = await readFile('patches/opencode/0017-cuppet-pe3-persisted-refresh.patch', 'utf8')
  assert.match(patch, /!nativeRoute\?\.rerouted && nativeRoute\?\.refreshPaths\.length/)
  assert.match(patch, /PE3 persisted task resume/)
  assert.match(patch, /current workspace truth/)
  assert.match(patch, /\.\.\.input\.parts/)
})
