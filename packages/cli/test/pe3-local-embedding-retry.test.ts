import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LocalTransformersEmbeddingProvider } from '../src/pe3/local-embedding.js'

test('transient extractor initialization failure is cleared so the next embed retries', async () => {
  let loads = 0
  let pipelines = 0
  const provider = new LocalTransformersEmbeddingProvider({
    allowModelDownload: false,
    loadTransformers: async () => {
      loads += 1
      if (loads === 1) throw new Error('transient model load failure')
      return {
        env: {},
        pipeline: async () => {
          pipelines += 1
          return async () => Float32Array.from([0.25, 0.75])
        },
      }
    },
  })

  await assert.rejects(provider.embed('first attempt'), /transient model load failure/)
  const vector = await provider.embed('second attempt')

  assert.deepEqual([...vector], [0.25, 0.75])
  assert.equal(loads, 2)
  assert.equal(pipelines, 1)
})

test('concurrent callers share one successful extractor initialization', async () => {
  let loads = 0
  let pipelines = 0
  let releasePipeline!: () => void
  const pipelineGate = new Promise<void>((resolve) => { releasePipeline = resolve })
  const provider = new LocalTransformersEmbeddingProvider({
    allowModelDownload: false,
    loadTransformers: async () => {
      loads += 1
      return {
        env: {},
        pipeline: async () => {
          pipelines += 1
          await pipelineGate
          return async (text: string) => Float32Array.from([text.length, 1])
        },
      }
    },
  })

  const first = provider.embed('alpha')
  const second = provider.embed('beta')
  const third = provider.embed('gamma')
  releasePipeline()
  const vectors = await Promise.all([first, second, third])

  assert.equal(loads, 1)
  assert.equal(pipelines, 1)
  assert.deepEqual(vectors.map((vector) => vector[1]), [1, 1, 1])
})

test('concurrent callers after a failure share exactly one retry', async () => {
  let loads = 0
  let pipelines = 0
  const provider = new LocalTransformersEmbeddingProvider({
    allowModelDownload: false,
    loadTransformers: async () => {
      loads += 1
      if (loads === 1) throw new Error('first load fails')
      return {
        env: {},
        pipeline: async () => {
          pipelines += 1
          return async () => Float32Array.from([1, 0])
        },
      }
    },
  })

  await assert.rejects(provider.embed('warmup'), /first load fails/)
  await Promise.all([
    provider.embed('retry one'),
    provider.embed('retry two'),
    provider.embed('retry three'),
  ])

  assert.equal(loads, 2)
  assert.equal(pipelines, 1)
})
