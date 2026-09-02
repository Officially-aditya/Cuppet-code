import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'

const patchedRoot = process.env.CUPPET_PE3_PATCHED_SOURCE
const derivativeAvailable = Boolean(patchedRoot)

test('applied derivative accepts target message, commits PE3, then starts target inference', { skip: !derivativeAvailable }, async () => {
  const source = await appliedPromptSource()
  const start = source.indexOf('if (nativeRoute?.rerouted) {')
  const end = source.indexOf('const message = yield* createUserMessage(input)', start)
  assert.ok(start >= 0 && end > start)
  const block = source.slice(start, end)

  const acceptance = block.indexOf('const acceptance = yield* prompt({')
  const acceptanceNoReply = block.indexOf('noReply: true', acceptance)
  const commit = block.indexOf('commitCuppetNativeRoute(routeToken)', acceptanceNoReply)
  const sourceNoReply = block.indexOf('noReply: true', commit)
  const loop = block.indexOf('loop({ sessionID: nativeRoute.targetSessionID })', sourceNoReply)

  assert.ok(acceptance >= 0, 'target message acceptance must be explicit')
  assert.ok(acceptanceNoReply > acceptance, 'target acceptance must persist without running inference')
  assert.ok(commit > acceptanceNoReply, 'PE3 must commit only after target message acceptance')
  assert.ok(sourceNoReply > commit, 'source suppression must happen only after successful commit')
  assert.ok(loop > sourceNoReply, 'target inference must start only after the route is committed')
})

test('applied derivative preserves multipart forwarding and recursive-route guard invariants', { skip: !derivativeAvailable }, async () => {
  const source = await appliedPromptSource()
  const start = source.indexOf('if (nativeRoute?.rerouted) {')
  const end = source.indexOf('const message = yield* createUserMessage(input)', start)
  const block = source.slice(start, end)

  assert.match(block, /const originalParts = input\.parts/)
  assert.match(block, /\.\.\.originalParts/)
  assert.match(block, /delete targetInput\.messageID/)
  assert.match(block, /sessionID: nativeRoute\.targetSessionID/)
  assert.match(block, /markCuppetNativeForward\(targetParts\)/)
})

test('applied derivative aborts before source suppression when target acceptance fails', { skip: !derivativeAvailable }, async () => {
  const source = await appliedPromptSource()
  const failure = source.indexOf('PE3 native reroute target acceptance failed; preserving source request')
  assert.ok(failure >= 0)
  const branchStart = source.lastIndexOf('} else {', failure)
  const branchEnd = source.indexOf('if (!nativeRoute?.rerouted && nativeRoute?.refreshPaths.length)', failure)
  assert.ok(branchStart >= 0 && branchEnd > failure)
  const branch = source.slice(branchStart, branchEnd)
  const abort = branch.indexOf('abortCuppetNativeRoute(routeToken)')
  const log = branch.indexOf('PE3 native reroute target acceptance failed; preserving source request')

  assert.ok(abort >= 0 && abort < log, 'provisional route must abort before the failure is reported')
  assert.doesNotMatch(branch, /\n\s*input = \{/, 'acceptance failure must leave source input unchanged')
})

test('applied persisted refresh hint is synthetic and keeps original parts', { skip: !derivativeAvailable }, async () => {
  const source = await appliedPromptSource()
  const marker = source.indexOf('[PE3 persisted task resume]')
  assert.ok(marker >= 0)
  const block = source.slice(Math.max(0, marker - 300), marker + 500)
  assert.match(block, /synthetic: true/)
  assert.match(block, /\.\.\.input\.parts/)
})

test('patch-line helper cannot be satisfied by behavior present only in a deleted line', () => {
  const syntheticPatch = [
    'diff --git a/example.ts b/example.ts',
    '--- a/example.ts',
    '+++ b/example.ts',
    '@@ -1 +1 @@',
    '-dangerousOldBehavior()',
    '+safeNewBehavior()',
  ].join('\n')

  const additions = addedPatchLines(syntheticPatch)
  assert.doesNotMatch(additions, /dangerousOldBehavior/)
  assert.match(additions, /safeNewBehavior/)
})

async function appliedPromptSource(): Promise<string> {
  assert.ok(patchedRoot)
  return readFile(resolve(patchedRoot, 'packages/opencode/src/session/prompt.ts'), 'utf8')
}

function addedPatchLines(patch: string): string {
  return patch
    .split('\n')
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1))
    .join('\n')
}
