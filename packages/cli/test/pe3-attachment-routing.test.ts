import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  nativeRoutingPrompt,
  parseNativeRoutingAttachments,
} from '../src/pe3/native-envelope.js'

test('bounded file metadata enriches routing identity without carrying payloads', () => {
  const attachments = parseNativeRoutingAttachments([
    { type: 'file', filename: 'dashboard.png', mime: 'image/png' },
    { type: 'file', filename: 'requirements.pdf', mime: 'application/pdf' },
  ])
  assert.deepEqual(attachments, [
    { type: 'file', filename: 'dashboard.png', mime: 'image/png' },
    { type: 'file', filename: 'requirements.pdf', mime: 'application/pdf' },
  ])
  const routed = nativeRoutingPrompt('Implement this dashboard', attachments)
  assert.match(routed, /Implement this dashboard/)
  assert.match(routed, /dashboard\.png image\/png/)
  assert.match(routed, /requirements\.pdf application\/pdf/)
  assert.doesNotMatch(routed, /data:|base64|https?:\/\//)
})

test('unsupported payload-bearing or malformed attachment metadata fails closed', () => {
  assert.throws(
    () => parseNativeRoutingAttachments([
      { type: 'file', filename: 'x.png', mime: 'image/png', url: 'data:image/png;base64,AAAA' },
    ]),
    /unsupported field url/,
  )
  assert.throws(
    () => parseNativeRoutingAttachments([{ type: 'file', filename: 'x.png' }]),
    /mime is required/,
  )
  assert.throws(
    () => parseNativeRoutingAttachments(Array.from({ length: 17 }, (_, index) => ({
      type: 'file', filename: `${index}.png`, mime: 'image/png',
    }))),
    /attachments exceed limit 16/,
  )
  assert.throws(
    () => parseNativeRoutingAttachments([{ type: 'file', filename: `${'x'.repeat(300)}.png`, mime: 'image/png' }]),
    /filename exceeds 256 bytes/,
  )
})

test('no attachment metadata leaves the routing text unchanged', () => {
  assert.equal(nativeRoutingPrompt('same task continuation', []), 'same task continuation')
})
