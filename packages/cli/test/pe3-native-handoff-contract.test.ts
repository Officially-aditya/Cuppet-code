import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const PATCH = new URL('../../../patches/opencode/0018-cuppet-pe3-attachment-routing.patch', import.meta.url)

test('native reroute suppresses the source only after target prompt success', async () => {
  const additions = await addedPatchLines()
  const handoff = additions.indexOf('const handoff = yield* prompt({')
  const exit = additions.indexOf('}).pipe(Effect.exit)', handoff)
  const success = additions.indexOf('if (Exit.isSuccess(handoff)) {', exit)
  const noReply = additions.indexOf('noReply: true', success)

  assert.ok(handoff >= 0, 'target handoff must be explicit')
  assert.ok(exit > handoff, 'target handoff must be observed through Effect.exit')
  assert.ok(success > exit, 'source suppression must be gated on successful target handoff')
  assert.ok(noReply > success, 'source noReply must only be committed inside the success branch')
  assert.equal(additions.includes('Effect.forkIn(scope)'), false, 'fire-and-forget target handoff is unsafe')
})

test('failed target handoff preserves source request and clears the forwarding guard', async () => {
  const additions = await addedPatchLines()
  const failure = additions.indexOf('} else {')
  const clear = additions.indexOf('clearCuppetNativeForward(targetParts)', failure)
  const log = additions.indexOf('PE3 native reroute handoff failed; preserving source request', failure)
  const sourceMutation = additions.indexOf('input = {', failure)

  assert.ok(failure >= 0)
  assert.ok(clear > failure, 'failed handoff must release the one-shot forwarding guard')
  assert.ok(log > failure, 'failed handoff must be observable in native logs')
  assert.equal(sourceMutation, -1, 'failure branch must leave the original source input untouched')
})

test('successful reroute still forwards original multipart content losslessly', async () => {
  const additions = await addedPatchLines()
  assert.match(additions, /const originalParts = input\.parts/)
  assert.match(additions, /\.\.\.originalParts/)
  assert.match(additions, /delete targetInput\.messageID/)
  assert.match(additions, /sessionID: nativeRoute\.targetSessionID/)
  assert.match(additions, /markCuppetNativeForward\(targetParts\)/)
})

async function addedPatchLines(): Promise<string> {
  const patch = await readFile(PATCH, 'utf8')
  return patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n')
}
