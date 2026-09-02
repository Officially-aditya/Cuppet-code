import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nativeSemanticAttachmentText } from '../src/pe3/native-envelope.js'
import {
  SemanticTaskRouter,
  type TaskEmbeddingProvider,
} from '../src/pe3/semantic-router.js'
import { TaskSessionRouter, type TaskSessionAdapter } from '../src/pe3/session-router.js'

test('explicit switch with a concrete disjoint path creates a fresh task even when lexical text is terse', async () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  const harness = adapterHarness()

  const auth = await router.prepare('fix auth expiry in src/auth/token.ts', harness.adapter)
  const dashboard = await router.prepare('new task: src/dashboard/view.ts', harness.adapter)

  assert.equal(auth.action, 'create')
  assert.equal(dashboard.action, 'create')
  assert.notEqual(dashboard.sessionID, auth.sessionID)
  assert.equal(harness.created, 2)
})

test('explicit switch wording does not force a split when the concrete path is still the active task path', async () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  const harness = adapterHarness()

  const auth = await router.prepare('fix auth expiry in src/auth/token.ts', harness.adapter)
  const samePath = await router.prepare('new task: src/auth/token.ts', harness.adapter)

  assert.equal(samePath.action, 'continue')
  assert.equal(samePath.sessionID, auth.sessionID)
  assert.equal(harness.created, 1)
})

test('a terse disjoint path mention without explicit switch intent preserves the conservative stay bias', async () => {
  const router = new TaskSessionRouter(undefined, { semantic: false })
  const harness = adapterHarness()

  const auth = await router.prepare('fix auth expiry in src/auth/token.ts', harness.adapter)
  const ambiguous = await router.prepare('check src/dashboard/view.ts', harness.adapter)

  assert.equal(ambiguous.action, 'continue')
  assert.equal(ambiguous.sessionID, auth.sessionID)
  assert.equal(harness.created, 1)
})

test('attachment metadata reaches semantic escalation without entering the persisted lexical task fingerprint', async () => {
  const provider = new RecordingEmbeddingProvider()
  const semantic = new SemanticTaskRouter(provider)
  const router = new TaskSessionRouter(undefined, { semantic })
  const harness = adapterHarness()

  await router.prepare('fix refresh expiry in src/auth/token.ts', harness.adapter)

  const prompt = 'adjust credential renewal behavior'
  const semanticContext = nativeSemanticAttachmentText([
    { type: 'file', filename: 'auth-screen.png', mime: 'image/png' },
  ])
  const result = await router.prepare(prompt, harness.adapter, { semanticContext })

  assert.equal(result.action, 'continue')
  assert.equal(provider.inputs[0], `${prompt}\n[attachment auth-screen.png image/png]`)

  const active = router.active
  assert.ok(active)
  assert.equal(active.taskDescriptor, prompt)
  assert.equal(active.taskDescriptor.includes('image/png'), false)
  assert.equal(active.fingerprint.terms.some((signal) => signal.value === 'attachment'), false)
  assert.equal(active.fingerprint.terms.some((signal) => signal.value === 'image'), false)
})

class RecordingEmbeddingProvider implements TaskEmbeddingProvider {
  readonly modelID = 'test-recording-embedding'
  readonly inputs: string[] = []

  async embed(text: string): Promise<Float32Array> {
    this.inputs.push(text)
    return Float32Array.from([1, 0])
  }
}

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
