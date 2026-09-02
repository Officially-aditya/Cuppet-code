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

test('PE3 derivative routes supported attachments without copying payloads through control RPC', async () => {
  const patch = await readFile('patches/opencode/0018-cuppet-pe3-attachment-routing.patch', 'utf8')

  assert.match(patch, /attachments: envelope\.attachments/)
  assert.match(patch, /value\.type === \"file\"/)
  assert.match(patch, /MAX_ATTACHMENT_METADATA_BYTES/)
  assert.doesNotMatch(patch, /attachments\.push\([^\n]*url/)

  // A normal reroute reuses the exact source parts array for the target. A
  // stale-task refresh may prepend one synthetic text part while retaining all
  // original parts unchanged after it.
  assert.match(patch, /const originalParts = input\.parts/)
  assert.match(patch, /: originalParts/)
  assert.match(patch, /\.\.\.originalParts/)
  assert.match(patch, /sessionID: nativeRoute\.targetSessionID/)
  assert.match(patch, /delete targetInput\.messageID/)

  // The target prompt is marked by object identity so its immediate recursive
  // invocation cannot ask PE3 to route the same request a second time.
  assert.match(patch, /markCuppetNativeForward\(targetParts\)/)
  assert.match(patch, /forwardedParts\.delete\(input\.parts\)/)
})

test('attachment routing keeps unsupported, attachment-only, and control-failure prompts on the source path', async () => {
  const patch = await readFile('patches/opencode/0018-cuppet-pe3-attachment-routing.patch', 'utf8')

  // No meaningful text means no routing envelope, so an attachment-only prompt
  // falls through to the unchanged source input.
  assert.match(patch, /if \(!prompt \|\| Buffer\.byteLength\(prompt\) > MAX_PROMPT_BYTES\) return/)
  // Unknown part kinds and oversized input fail closed instead of dropping data.
  assert.match(patch, /parts\.length === 0 \|\| parts\.length > MAX_PARTS/)
  assert.match(patch, /Agent\/subtask\/unknown prompt parts cannot be forwarded/)
  // Socket error or timeout resolves to undefined; input is only replaced when
  // a concrete reroute result exists.
  assert.match(patch, /\.catch\(\(\) => undefined\)/)
  assert.match(patch, /setTimeout\(\(\) => finish\(\), ROUTE_TIMEOUT_MS\)/)
  assert.match(patch, /if \(nativeRoute\?\.rerouted\)/)
})

test('successful native reroute marks source noReply immediately while target inference runs separately', async () => {
  const patch = await readFile('patches/opencode/0018-cuppet-pe3-attachment-routing.patch', 'utf8')
  assert.match(patch, /Effect\.forkDaemon\(prompt\(/)
  assert.match(patch, /noReply: true/)
  assert.match(patch, /PE3 routed this request to task session/)
})
