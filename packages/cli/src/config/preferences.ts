import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { ModelRef, Platform } from '../types.js'

const modelRef = z.object({
  providerID: z.string().min(1),
  modelID: z.string().min(1),
  variant: z.string().min(1).optional(),
})

const preferencesSchema = z.object({
  schema: z.literal(1),
  platform: z.enum(['anthropic', 'openai', 'google', 'opencode']).optional(),
  primary: modelRef.optional(),
  secondary: modelRef.optional(),
  backgroundPaused: z.boolean().default(false),
  lastSessionByProject: z.record(z.string(), z.string()).default({}),
})

export type Preferences = {
  schema: 1
  platform?: Platform | undefined
  primary?: ModelRef | undefined
  secondary?: ModelRef | undefined
  backgroundPaused: boolean
  lastSessionByProject: Record<string, string>
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
      const parsed: unknown = JSON.parse(await readFile(this.#path, 'utf8'))
      this.#value = preferencesSchema.parse(parsed)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    return this.value
  }

  get value(): Preferences {
    return structuredClone(this.#value)
  }

  async update(change: Partial<Omit<Preferences, 'schema'>>): Promise<Preferences> {
    this.#value = preferencesSchema.parse({ ...this.#value, ...change, schema: 1 })
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
