import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  nativeRoutingPrompt,
  nativeSemanticAttachmentText,
  parseNativeRoutingAttachments,
} from '../src/pe3/native-envelope.js'
import { TaskAgentRouter } from '../src/pe3/task-agents.js'
import { TaskSessionRouter, type TaskSessionAdapter } from '../src/pe3/session-router.js'

test('bounded attachment metadata stays structured and out of deterministic task text', () => {
  const attachments = parseNativeRoutingAttachments([
    { type: 'file', filename: 'dashboard.png', mime: 'image/png' },
    { type: 'file', filename: 'requirements.pdf', mime: 'application/pdf' },
  ])
  assert.deepEqual(attachments, [
    { type: 'file', filename: 'dashboard.png', mime: 'image/png' },
    { type: 'file', filename: 'requirements.pdf', mime: 'application/pdf' },
  ])

  const routed = nativeRoutingPrompt('Implement this dashboard', attachments)
  assert.equal(routed, 'Implement this dashboard')
  assert.doesNotMatch(routed, /attachment|image\/png|application\/pdf/)

  const semantic = nativeSemanticAttachmentText(attachments)
  assert.match(semantic, /dashboard\.png image\/png/)
  assert.match(semantic, /requirements\.pdf application\/pdf/)
  assert.doesNotMatch(semantic, /data:|base64|https?:\/\//)
})

test('attachment MIME classes cannot become deterministic task paths', () => {
  const router = new TaskAgentRouter()
  router.register(
    's1',
    'inspect image/png and application/json while working in src/auth/token.ts',
    {
      activePaths: ['image/png', 'src/auth/token.ts'],
      touchedPaths: ['application/json'],
    },
  )

  const active = router.active
  assert.ok(active)
  assert.deepEqual(active.activePaths, ['src/auth/token.ts'])
  assert.deepEqual(active.touchedPaths, [])
  assert.equal(active.fingerprint.paths.some((signal) => signal.value === 'image/png'), false)
  assert.equal(active.fingerprint.paths.some((signal) => signal.value === 'application/json'), false)
  assert.equal(active.fingerprint.paths.some((signal) => signal.value === 'src/auth/token.ts'), true)
})

test('same-task attachment request preserves the active cache-friendly session', async () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  const harness = adapterHarness()
  const screenshot = [{ type: 'file' as const, filename: 'token-expiry.png', mime: 'image/png' }]

  const first = await router.prepare(
    nativeRoutingPrompt('fix refresh expiry in src/auth/token.ts', screenshot),
    harness.adapter,
  )
  const continued = await router.prepare(
    nativeRoutingPrompt('update src/auth/token.ts to match this screenshot', screenshot),
    harness.adapter,
  )

  assert.equal(continued.action, 'continue')
  assert.equal(continued.sessionID, first.sessionID)
  assert.equal(harness.created, 1)
})

test('two unrelated image tasks split without an explicit switch cue', async () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  const harness = adapterHarness()
  const auth = [{ type: 'file' as const, filename: 'auth.png', mime: 'image/png' }]
  const dashboard = [{ type: 'file' as const, filename: 'dashboard.png', mime: 'image/png' }]

  const first = await router.prepare(
    nativeRoutingPrompt('fix auth expiry in src/auth/token.ts', auth),
    harness.adapter,
  )
  const switched = await router.prepare(
    nativeRoutingPrompt('implement src/dashboard/view.ts from this screenshot', dashboard),
    harness.adapter,
  )

  assert.equal(switched.action, 'create')
  assert.notEqual(switched.sessionID, first.sessionID)
  assert.equal(harness.created, 2)
})

test('unrelated JSON tasks do not inherit lexical affinity from application/json', async () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  const harness = adapterHarness()
  const firstAttachment = [{ type: 'file' as const, filename: 'auth-response.json', mime: 'application/json' }]
  const secondAttachment = [{ type: 'file' as const, filename: 'forecast.json', mime: 'application/json' }]

  const first = await router.prepare(
    nativeRoutingPrompt('fix auth parsing in src/auth/parser.ts', firstAttachment),
    harness.adapter,
  )
  const switched = await router.prepare(
    nativeRoutingPrompt('implement weather parsing in src/weather/parser.ts', secondAttachment),
    harness.adapter,
  )

  assert.equal(switched.action, 'create')
  assert.notEqual(switched.sessionID, first.sessionID)
  assert.equal(harness.created, 2)
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
    () => parseNativeRoutingAttachments([{ type: 'file', filename: 'x.png', mime: 'image/png;base64,AAAA' }]),
    /mime must be a media type/,
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
  assert.equal(nativeSemanticAttachmentText([]), '')
})

function adapterHarness(): {
  adapter: TaskSessionAdapter
  readonly created: number
} {
  let currentID: string | undefined
  let created = 0
  const adapter: TaskSessionAdapter = {
    current: () => currentID ? { id: currentID } : undefined,
    create: async () => {
      created += 1
      currentID = `s${created}`
      return { id: currentID }
    },
    resume: async (sessionID) => {
      currentID = sessionID
      return { id: sessionID }
    },
    evidence: () => ({}),
  }
  return {
    adapter,
    get created() { return created },
  }
}
