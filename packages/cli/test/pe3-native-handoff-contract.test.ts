import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const FAILURE_SAFE_PATCH = new URL('../../../patches/opencode/0018-cuppet-pe3-attachment-routing.patch', import.meta.url)
const TRANSACTION_PATCH = new URL('../../../patches/opencode/0019-cuppet-pe3-transactional-routing.patch', import.meta.url)

test('native reroute commits PE3 state only after target prompt success and before source suppression', async () => {
  const additions = await addedPatchLines(TRANSACTION_PATCH)
  const handoff = additions.indexOf('const handoff = yield* prompt({')
  const exit = additions.indexOf('}).pipe(Effect.exit)', handoff)
  const success = additions.indexOf('if (Exit.isSuccess(handoff)) {', exit)
  const commit = additions.indexOf('commitCuppetNativeRoute(routeToken)', success)
  const noReply = additions.indexOf('noReply: true', commit)

  assert.ok(handoff >= 0, 'target handoff must be explicit')
  assert.ok(exit > handoff, 'target handoff must be observed through Effect.exit')
  assert.ok(success > exit, 'transaction commit must be gated on successful target handoff')
  assert.ok(commit > success, 'PE3 state must commit only after target success')
  assert.ok(noReply > commit, 'source noReply must follow the PE3 commit attempt')
})

test('failed target handoff aborts provisional PE3 state and preserves the source request', async () => {
  const additions = await addedPatchLines(TRANSACTION_PATCH)
  const failure = additions.indexOf('} else {', additions.indexOf('if (Exit.isSuccess(handoff)) {'))
  const clear = additions.indexOf('clearCuppetNativeForward(targetParts)', failure)
  const abort = additions.indexOf('abortCuppetNativeRoute(routeToken)', failure)
  const log = additions.indexOf('PE3 native reroute handoff failed; preserving source request', failure)
  const sourceMutation = additions.indexOf('input = {', failure)

  assert.ok(failure >= 0)
  assert.ok(clear > failure, 'failed handoff must release the one-shot forwarding guard')
  assert.ok(abort > clear, 'failed handoff must abort the provisional PE3 route')
  assert.ok(log > abort, 'failed handoff and abort outcome must be observable')
  assert.equal(sourceMutation, -1, 'failure branch must leave the original source input untouched')
})

test('missing transaction token fails closed to the original source request', async () => {
  const additions = await addedPatchLines(TRANSACTION_PATCH)
  assert.match(additions, /if \(!routeToken\)/)
  assert.match(additions, /missing transaction token; preserving source request/)
})

test('successful reroute still forwards original multipart content losslessly', async () => {
  const additions = await addedPatchLines(TRANSACTION_PATCH)
  assert.match(additions, /const originalParts = input\.parts/)
  assert.match(additions, /\.\.\.originalParts/)
  assert.match(additions, /delete targetInput\.messageID/)
  assert.match(additions, /sessionID: nativeRoute\.targetSessionID/)
  assert.match(additions, /markCuppetNativeForward\(targetParts\)/)
})

test('the earlier failure-safe patch no longer uses fire-and-forget handoff', async () => {
  const additions = await addedPatchLines(FAILURE_SAFE_PATCH)
  assert.equal(additions.includes('Effect.forkIn(scope)'), false)
})

async function addedPatchLines(url: URL): Promise<string> {
  const patch = await readFile(url, 'utf8')
  return patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n')
}
