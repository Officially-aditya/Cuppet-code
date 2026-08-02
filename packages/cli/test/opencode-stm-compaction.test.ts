import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

const patchPath = join(import.meta.dirname, '../../../patches/opencode/0015-cuppet-stm-only-compaction.patch')
const hookPatchPath = join(import.meta.dirname, '../../../patches/opencode/0009-cuppet-model-context-hook.patch')

test('OpenCode derivative carries STM compaction directives through the hook', async () => {
  const patch = await readFile(patchPath, 'utf8')
  const hookPatch = await readFile(hookPatchPath, 'utf8')
  assert.match(patch, /compaction:\s*\{[\s\S]*mode: process\.env\.CUPPET_STM_ONLY_COMPACTION === "1" \? "stm_only" : "native"/)
  assert.match(hookPatch, /history:\s*\{[\s\S]*usableTokens: usable\(/)
  assert.match(patch, /cuppetCompaction\?: \{[\s\S]*abort: boolean[\s\S]*directive: string/)
  assert.match(patch, /transformed,/)
  assert.match(patch, /transformed\.cuppetCompaction\?\.mode === "stm_only"/)
})

test('STM refresh failure is checked before the native compaction record write', async () => {
  const patch = await readFile(patchPath, 'utf8')
  const abort = patch.indexOf('transformed.cuppetCompaction?.abort')
  const write = patch.indexOf('session.updateMessage(msg)')
  assert.ok(abort >= 0)
  assert.ok(write > abort, 'abort must be evaluated before transcript mutation')
  assert.match(patch, /session\.updatePart\(\{[\s\S]*type: "text"[\s\S]*transformed\.cuppetCompaction\.directive/)
})

test('disabled mode retains the native transformed-message path', async () => {
  const hookPatch = await readFile(hookPatchPath, 'utf8')
  assert.match(hookPatch, /MessageV2\.toModelMessagesEffect\(transformed\.messages, model\)/)
  const patch = await readFile(patchPath, 'utf8')
  assert.match(patch, /mode: process\.env\.CUPPET_STM_ONLY_COMPACTION === "1" \? "stm_only" : "native"/)
  assert.match(patch, /const modelMessages = yield\* MessageV2\.toModelMessagesEffect\(transformed\.messages, model/)
})
