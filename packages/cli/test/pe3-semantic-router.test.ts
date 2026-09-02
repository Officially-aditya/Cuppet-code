import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LocalTransformersEmbeddingProvider } from '../src/pe3/local-embedding.js'
import {
  SemanticTaskRouter,
  type TaskEmbeddingProvider,
} from '../src/pe3/semantic-router.js'
import {
  TaskAgentRouter,
  taskFingerprintText,
  type TaskAgentState,
} from '../src/pe3/task-agents.js'

test('vocabulary-gap continuation stays on the active task without explicit cue words', async () => {
  const provider = semanticProvider()
  const semantic = new SemanticTaskRouter(provider)
  const active = agent('auth', 'fix refresh token expiration in src/auth/token.ts')
  const dormant = agent('analytics', 'add analytics csv export pagination')
  const prompt = 'repair the oauth credential renewal lifecycle regression'

  const decision = await semantic.decide(prompt, active, [dormant])

  assert.equal(decision.action, 'continue')
  assert.ok(decision.activeSimilarity >= 0.99)
  assert.equal(decision.promptEmbeddingCount, 1)
  assert.equal(provider.calls.filter((value) => value === prompt).length, 1)
})

test('natural unrelated request can create a fresh task without magic switch wording', async () => {
  const semantic = new SemanticTaskRouter(semanticProvider())
  const active = agent('auth', 'fix refresh token expiration')

  const decision = await semantic.decide('add pagination to the csv export pipeline', active, [])

  assert.equal(decision.action, 'create')
  assert.ok(decision.activeSimilarity < 0.1)
  assert.match(decision.reason, /novelty/)
})

test('semantic dormant matching happens before novelty and handles rephrased returns', async () => {
  const semantic = new SemanticTaskRouter(semanticProvider())
  const active = agent('analytics', 'build csv export pagination')
  const dormant = agent('auth', 'fix refresh token expiration')

  const decision = await semantic.decide(
    'the oauth credential renewal lifecycle is broken again',
    active,
    [dormant],
  )

  assert.equal(decision.action, 'reactivate')
  assert.equal(decision.agent?.sessionID, 'auth')
  assert.ok((decision.bestDormantSimilarity ?? 0) > decision.activeSimilarity)
})

test('close semantic race defaults to the active task instead of false splitting', async () => {
  const provider = mappedProvider((text) => {
    if (text === 'follow up phrased differently') return vector(0.99, 0.1)
    if (text.includes('active identity')) return vector(1, 0)
    if (text.includes('dormant identity')) return vector(0.98, 0.2)
    return vector(1, 0)
  })
  const semantic = new SemanticTaskRouter(provider)
  const active = agent('active', 'active identity')
  const dormant = agent('dormant', 'dormant identity')

  const decision = await semantic.decide('follow up phrased differently', active, [dormant])

  assert.equal(decision.action, 'continue')
  assert.equal(decision.fallback, false)
})

test('embedding failure safely preserves deterministic active routing', async () => {
  const provider: TaskEmbeddingProvider = {
    modelID: 'broken-local-model',
    embed: async () => {
      throw new Error('model assets unavailable')
    },
  }
  const semantic = new SemanticTaskRouter(provider)

  const decision = await semantic.decide('implement rate limiting', agent('auth', 'fix refresh token expiration'), [])

  assert.equal(decision.action, 'continue')
  assert.equal(decision.fallback, true)
  assert.match(decision.error ?? '', /model assets unavailable/)
  assert.equal(decision.promptEmbeddingCount, 0)
})

test('semantic thresholds are constructor-calibratable from benchmark traces', async () => {
  const provider = mappedProvider((text) => {
    if (text === 'moderately novel request') return vector(0.4, Math.sqrt(0.84))
    return vector(1, 0)
  })
  const active = agent('active', 'active identity')
  const conservative = new SemanticTaskRouter(provider)
  const calibrated = new SemanticTaskRouter(provider, { noveltyMax: 0.45 })

  assert.equal((await conservative.decide('moderately novel request', active, [])).action, 'continue')
  assert.equal((await calibrated.decide('moderately novel request', active, [])).action, 'create')
})

test('task fingerprint privileges touched activity over prompt mentions', () => {
  let now = 1_000
  const router = new TaskAgentRouter({ now: () => now })
  router.register('s1', 'inspect src/auth/token.ts and maybe src/report/export.ts')
  const initial = router.active
  assert.ok(initial)
  const mentioned = initial!.fingerprint.paths.find((signal) => signal.value === 'src/auth/token.ts')
  assert.equal(mentioned?.source, 'prompt')
  assert.ok((mentioned?.weight ?? 0) < 0.6)

  now += 1
  router.recordTurn('', { touchedPaths: ['src/auth/token.ts'] })
  const strengthened = router.active!
  const touched = strengthened.fingerprint.paths.find((signal) => signal.value === 'src/auth/token.ts')
  assert.equal(touched?.source, 'touched')
  assert.equal(touched?.weight, 1)
  assert.match(taskFingerprintText(strengthened), /src\/auth\/token\.ts\(1\.00\)/)
})

test('localized query evidence is not promoted into active task identity before routing commits it', () => {
  const router = new TaskAgentRouter()
  router.register('s1', 'fix auth refresh behavior in src/auth/token.ts')

  const route = router.route('implement organization migration support', {
    localizedPaths: ['src/org/migration.ts'],
    localizedSymbols: ['OrganizationMigration'],
  })

  assert.equal(route.action, 'create')
  assert.equal(router.active?.activePaths.includes('src/org/migration.ts'), false)
  assert.equal(router.active?.fingerprint.paths.some((signal) => signal.value === 'src/org/migration.ts'), false)
})

test('local Transformers adapter is lazy and can be forced fully offline', async () => {
  let pipelineLoads = 0
  const env: Record<string, unknown> = {}
  const provider = new LocalTransformersEmbeddingProvider({
    modelID: 'test/minilm',
    cacheDir: '/tmp/cuppet-model-test',
    allowModelDownload: false,
    loadTransformers: async () => ({
      env,
      pipeline: async (task, modelID) => {
        pipelineLoads += 1
        assert.equal(task, 'feature-extraction')
        assert.equal(modelID, 'test/minilm')
        return async (_text, options) => {
          assert.deepEqual(options, { pooling: 'mean', normalize: true })
          return { data: new Float32Array([0.6, 0.8]) }
        }
      },
    }),
  })

  assert.equal(pipelineLoads, 0)
  assert.deepEqual([...await provider.embed('first')], [0.6000000238418579, 0.800000011920929])
  assert.deepEqual([...await provider.embed('second')], [0.6000000238418579, 0.800000011920929])
  assert.equal(pipelineLoads, 1)
  assert.equal(env.allowRemoteModels, false)
  assert.equal(env.allowLocalModels, true)
})

function agent(sessionID: string, prompt: string): TaskAgentState {
  return new TaskAgentRouter().register(sessionID, prompt)
}

function semanticProvider(): ReturnType<typeof mappedProvider> {
  return mappedProvider((text) => {
    const normalized = text.toLowerCase()
    if (normalized.includes('refresh token') || normalized.includes('credential renewal') || normalized.includes('oauth')) {
      return vector(1, 0, 0)
    }
    if (normalized.includes('csv') || normalized.includes('analytics') || normalized.includes('export pagination')) {
      return vector(0, 1, 0)
    }
    if (normalized.includes('billing') || normalized.includes('invoice')) return vector(0, 0, 1)
    return vector(0.25, 0.25, Math.sqrt(0.875))
  })
}

function mappedProvider(map: (text: string) => Float32Array): TaskEmbeddingProvider & { calls: string[] } {
  const calls: string[] = []
  return {
    modelID: 'synthetic-local-embedding',
    calls,
    embed: async (text) => {
      calls.push(text)
      return map(text)
    },
  }
}

function vector(...values: number[]): Float32Array {
  return Float32Array.from(values)
}
