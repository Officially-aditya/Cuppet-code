import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { ModelRef, ProviderID } from '../types.js'

const modelRef = z.object({
  providerID: z.string().min(1),
  modelID: z.string().min(1),
  variant: z.string().min(1).optional(),
})

const preferencesSchema = z.object({
  schema: z.literal(1),
  provider: z.string().trim().min(1).optional(),
  // Accepted only to migrate preferences written by older Cuppet versions.
  platform: z.string().trim().min(1).optional(),
  primary: modelRef.optional(),
  secondary: modelRef.optional(),
  vertexProject: z.string().min(1).optional(),
  backgroundPaused: z.boolean().default(false),
  orchestratorEnabled: z.boolean().optional(),
  lastSessionByProject: z.record(z.string(), z.string()).default({}),
})

export type Preferences = {
  schema: 1
  provider?: ProviderID | undefined
  /** @deprecated Read migration input only. New writes use provider. */
  platform?: string | undefined
  primary?: ModelRef | undefined
  secondary?: ModelRef | undefined
  vertexProject?: string | undefined
  backgroundPaused: boolean
  orchestratorEnabled?: boolean | undefined
  lastSessionByProject: Record<string, string>
}

export function migrateLegacyPlatform(platform: string): ProviderID {
  // The old Vertex platform represented two OpenCode integrations. Keep the
  // Cuppet grouping ID so the live catalog can resolve both integrations.
  return platform === 'vertex' ? 'vertex' : platform
}

export class PreferenceStore {
  readonly #path: string
  #value: Preferences = {
    schema: 1,
    backgroundPaused: false,
    lastSessionByProject: {},
  }

  constructor(path: string) {
    this.#path = path
  }

  async load(): Promise<Preferences> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.#path, 'utf8'))
      this.#value = canonicalPreferences(raw)
      if (hasLegacyPlatform(raw)) await this.#persist()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    return this.value
  }

  get value(): Preferences {
    return structuredClone(this.#value)
  }

  async update(change: Partial<Omit<Preferences, 'schema'>>): Promise<Preferences> {
    this.#value = canonicalPreferences({ ...this.#value, ...change, schema: 1 })
    await this.#persist()
    return this.value
  }

  async setLastSession(projectID: string, sessionID: string): Promise<void> {
    await this.update({
      lastSessionByProject: { ...this.#value.lastSessionByProject, [projectID]: sessionID },
    })
  }

  async #persist(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 })
    const temporary = `${this.#path}.${randomBytes(6).toString('hex')}.tmp`
    await writeFile(temporary, `${JSON.stringify(this.#value, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, this.#path)
  }
}

function canonicalPreferences(value: unknown): Preferences {
  const parsed = preferencesSchema.parse(value)
  const { platform: legacyPlatform, ...canonical } = parsed
  const provider = parsed.provider ?? (legacyPlatform ? migrateLegacyPlatform(legacyPlatform) : undefined)
  const primary = normalizeLegacyVertexReference(parsed.primary)
  const secondary = normalizeLegacyVertexReference(parsed.secondary)
  return {
    ...canonical,
    ...(provider ? { provider } : {}),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
  }
}

function hasLegacyPlatform(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && 'platform' in value)
}

function normalizeLegacyVertexReference(reference: ModelRef | undefined): ModelRef | undefined {
  if (!reference || reference.providerID !== 'vertex') return reference
  return { ...reference, providerID: 'google-vertex' }
}
