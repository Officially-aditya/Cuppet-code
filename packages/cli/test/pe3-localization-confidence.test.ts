import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TstTaskLocalizer, type TaskLocalizationEvidence } from '../src/pe3/localizer.js'
import { SemanticTaskRouter, type TaskEmbeddingProvider } from '../src/pe3/semantic-router.js'
import { TaskSessionRouter, type TaskSessionAdapter } from '../src/pe3/session-router.js'
import type { TstClient } from '../src/tst/client.js'

test('zero-score localization remains soft metadata and exposes no hard path evidence', async () => {
  const localized = await localize([
    { score: 0, node: { path: 'src/noise.ts', name: 'Noise' } },
  ])
  assert.equal(localized.localization?.decisive, false)
  assert.equal(localized.localization?.topScore, 0)
  assert.equal(localized.localizedPaths, undefined)
  assert.equal(localized.localizedSymbols, undefined)
})

test('missing localization scores cannot become hard structural evidence', async () => {
  const localized = await localize([
    { node: { path: 'src/noise.ts', name: 'Noise' } },
  ])
  assert.equal(localized.localization?.decisive, false)
  assert.equal(localized.localizedPaths, undefined)
})

test('nearly tied graph winners remain soft even when their absolute scores are high', async () => {
  const localized = await localize([
    { score: 0.8, node: { path: 'src/a.ts', name: 'A' } },
    { score: 0.76, node: { path: 'src/b.ts', name: 'B' } },
  ])
  assert.equal(localized.localization?.decisive, false)
  assert.match(localized.localization?.reason ?? '', /margin/)
  assert.equal(localized.localizedPaths, undefined)
})

test('a strong separated graph winner emits bounded hard localization evidence', async () => {
  const localized = await localize([
    { score: 0.95, node: { path: 'src/auth/token.ts', name: 'RefreshToken' } },
    { score: 0.7, node: { path: 'src/auth/oauth.ts', name: 'OAuthSession' } },
    { score: 0.1, node: { path: 'src/noise.ts', name: 'Noise' } },
  ])
  assert.equal(localized.localization?.decisive, true)
  assert.deepEqual(localized.localizedPaths, ['src/auth/token.ts', 'src/auth/oauth.ts'])
  assert.deepEqual(localized.localizedSymbols, ['RefreshToken', 'OAuthSession'])
})

test('weak disjoint localization falls through to semantic continuation instead of forcing a split', async () => {
  const provider: TaskEmbeddingProvider = {
    modelID: 'same-task-semantic',
    embed: async () => new Float32Array([1, 0, 0]),
  }
  const router = new TaskSessionRouter(undefined, { semantic: new SemanticTaskRouter(provider) })
  const harness = adapterHarness(async () => ({
    localization: {
      topScore: 0.2,
      runnerUpScore: 0.19,
      decisive: false,
      reason: 'graph localization top score is below the hard-evidence floor',
    },
  }))

  const first = await router.prepare('refactor provider discovery in src/platforms.ts', harness.adapter)
  const second = await router.prepare('implement request retry middleware', harness.adapter)

  assert.equal(second.action, 'continue')
  assert.equal(second.sessionID, first.sessionID)
  const stats = router.stats()
  assert.equal(stats.localizationQueries, 1)
  assert.equal(stats.localizationWeak, 1)
  assert.equal(stats.localizationHits, 0)
  assert.equal(stats.semanticEscalations, 1)
  assert.match(stats.lastLocalizationReason ?? '', /floor/)
})

test('real local embedding smoke can run against pre-staged assets without network access', { skip: !process.env.CUPPET_PE3_MODEL_DIR }, async () => {
  const { LocalTransformersEmbeddingProvider } = await import('../src/pe3/local-embedding.js')
  const provider = new LocalTransformersEmbeddingProvider({ allowModelDownload: false })
  const vector = await provider.embed('refresh token lifecycle')
  assert.ok(vector.length > 0)
})

async function localize(graph: Array<{ score?: number; node: { path?: string; name?: string } }>) {
  const client = {
    connected: true,
    call: async () => ({ graph }),
  } as unknown as TstClient
  return new TstTaskLocalizer(client).locate('s1', 'locate this code')
}

function adapterHarness(localize: (sessionID: string, prompt: string) => Promise<TaskLocalizationEvidence>) {
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
    localize,
  }
  return { adapter }
}
