import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  nativeRoutingPrompt,
  parseNativeRoutingAttachments,
} from '../src/pe3/native-envelope.js'
import { TaskSessionRouter, type TaskSessionAdapter } from '../src/pe3/session-router.js'

test('native attachment routing keeps payload transport outside PE3 decision input', async () => {
  assert.throws(
    () => parseNativeRoutingAttachments([
      { type: 'file', filename: 'dashboard.png', mime: 'image/png', url: 'data:image/png;base64,AAAA' },
    ]),
    /unsupported field url/,
  )

  const attachments = parseNativeRoutingAttachments([
    { type: 'file', filename: 'dashboard.png', mime: 'image/png' },
  ])
  const deterministic = nativeRoutingPrompt('implement src/dashboard/view.ts', attachments)
  assert.equal(deterministic, 'implement src/dashboard/view.ts')
  assert.doesNotMatch(deterministic, /dashboard\.png|image\/png|attachment/)
})

test('attachment-aware PE3 decision changes sessions without submitting model work itself', async () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  let currentID: string | undefined
  let created = 0
  let resumed = 0
  const adapter: TaskSessionAdapter = {
    current: () => currentID ? { id: currentID } : undefined,
    create: async () => {
      created += 1
      currentID = `s${created}`
      return { id: currentID }
    },
    resume: async (sessionID) => {
      resumed += 1
      currentID = sessionID
      return { id: sessionID }
    },
    evidence: () => ({}),
  }

  const first = await router.prepare('fix auth parser in src/auth/parser.ts', adapter)
  const second = await router.prepare('implement dashboard in src/dashboard/view.ts', adapter)

  assert.equal(first.action, 'create')
  assert.equal(second.action, 'create')
  assert.equal(created, 2)
  assert.equal(resumed, 0)
})
