import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TaskEmbeddingProvider } from './semantic-router.js'

const DEFAULT_MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

type FeatureExtractor = (
  text: string,
  options: { pooling: 'mean'; normalize: true },
) => Promise<{ data?: ArrayLike<number> } | ArrayLike<number>>

type TransformersModule = {
  env: {
    allowRemoteModels?: boolean
    allowLocalModels?: boolean
    cacheDir?: string
    localModelPath?: string
  }
  pipeline: (
    task: 'feature-extraction',
    modelID: string,
    options?: { device?: 'cpu' },
  ) => Promise<FeatureExtractor>
}

export type LocalEmbeddingOptions = {
  modelID?: string
  cacheDir?: string
  localModelPath?: string
  allowModelDownload?: boolean
  loadTransformers?: () => Promise<TransformersModule>
}

/**
 * Lazy, local-inference embedding provider for PE3's ambiguous routing band.
 *
 * The embedding model is never loaded on normal deterministic turns. By
 * default model assets may be fetched once into Cuppet's cache, but inference
 * itself is local; set CUPPET_PE3_ALLOW_MODEL_DOWNLOAD=0 for strict offline
 * operation or CUPPET_PE3_MODEL_DIR to point at pre-staged model assets.
 */
export class LocalTransformersEmbeddingProvider implements TaskEmbeddingProvider {
  readonly modelID: string
  readonly #cacheDir: string
  readonly #localModelPath: string | undefined
  readonly #allowModelDownload: boolean
  readonly #loadTransformers: () => Promise<TransformersModule>
  #extractor: Promise<FeatureExtractor> | undefined

  constructor(options: LocalEmbeddingOptions = {}) {
    this.modelID = options.modelID ?? process.env.CUPPET_PE3_EMBED_MODEL ?? DEFAULT_MODEL_ID
    this.#cacheDir = options.cacheDir
      ?? process.env.CUPPET_PE3_MODEL_CACHE
      ?? join(homedir(), '.cache', 'cuppet', 'transformers')
    this.#localModelPath = options.localModelPath ?? process.env.CUPPET_PE3_MODEL_DIR
    this.#allowModelDownload = options.allowModelDownload
      ?? process.env.CUPPET_PE3_ALLOW_MODEL_DOWNLOAD !== '0'
    this.#loadTransformers = options.loadTransformers ?? loadTransformers
  }

  async embed(text: string): Promise<Float32Array> {
    const normalized = text.trim()
    if (!normalized) throw new Error('cannot embed an empty task description')
    const extractor = await this.#getExtractor()
    const output = await extractor(normalized, { pooling: 'mean', normalize: true })
    const data = isArrayLike(output) ? output : output.data
    if (!data || data.length === 0) throw new Error('local embedding model returned no values')
    return Float32Array.from(data)
  }

  #getExtractor(): Promise<FeatureExtractor> {
    if (this.#extractor) return this.#extractor
    const pending = this.#createExtractor()
    this.#extractor = pending
    void pending.catch(() => {
      if (this.#extractor === pending) this.#extractor = undefined
    })
    return pending
  }

  async #createExtractor(): Promise<FeatureExtractor> {
    const transformers = await this.#loadTransformers()
    transformers.env.allowLocalModels = true
    transformers.env.allowRemoteModels = this.#allowModelDownload
    transformers.env.cacheDir = this.#cacheDir
    if (this.#localModelPath) transformers.env.localModelPath = this.#localModelPath
    return transformers.pipeline('feature-extraction', this.modelID, { device: 'cpu' })
  }
}

async function loadTransformers(): Promise<TransformersModule> {
  // Keep the module lazy so the normal deterministic PE3 path pays neither
  // import nor ONNX initialization cost. A variable specifier also keeps this
  // adapter swappable for benchmark/model calibration.
  const moduleName: string = '@huggingface/transformers'
  return import(moduleName) as Promise<TransformersModule>
}

function isArrayLike(value: unknown): value is ArrayLike<number> {
  if (!value || typeof value !== 'object') return false
  const length = (value as { length?: unknown }).length
  return typeof length === 'number' && Number.isFinite(length) && length >= 0
}
