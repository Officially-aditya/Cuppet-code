import { mkdir, readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

export type ProviderType = 'anthropic' | 'openai' | 'google'

export type CredentialsStore = {
  activeProvider: ProviderType
  anthropicApiKey?: string
  openaiApiKey?: string
  googleApiKey?: string
  primaryModel: string
  secondaryModel: string
}

const CONFIG_DIR = join(homedir(), '.cuppet')
const CRED_FILE = join(CONFIG_DIR, 'credentials.json')

export class ProviderAuth {
  private store: CredentialsStore = {
    activeProvider: 'google',
    primaryModel: 'gemini-3.6-flash',
    secondaryModel: 'gemini-3.5-flash-lite',
  }

  async init(): Promise<CredentialsStore> {
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 })
    try {
      const data = await readFile(CRED_FILE, 'utf8')
      const parsed = JSON.parse(data)
      this.store = { ...this.store, ...parsed }
    } catch {
      await this.autoDetectCredentials()
    }
    return this.store
  }

  async autoDetectCredentials(): Promise<void> {
    // 1. Check process environment variables
    if (process.env.ANTHROPIC_API_KEY) {
      this.store.anthropicApiKey = process.env.ANTHROPIC_API_KEY
      this.store.activeProvider = 'anthropic'
      this.store.primaryModel = 'claude-3-7-sonnet-20250219'
      this.store.secondaryModel = 'claude-3-5-haiku-20241022'
    }
    if (process.env.OPENAI_API_KEY) {
      this.store.openaiApiKey = process.env.OPENAI_API_KEY
      if (!this.store.anthropicApiKey) {
        this.store.activeProvider = 'openai'
        this.store.primaryModel = 'gpt-4o'
        this.store.secondaryModel = 'gpt-4o-mini'
      }
    }
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
      this.store.googleApiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY
      this.store.activeProvider = 'google'
      this.store.primaryModel = 'gemini-3.6-flash'
      this.store.secondaryModel = 'gemini-3.5-flash-lite'
    }

    // 2. Check ~/.claude.json for Anthropic credentials
    try {
      const claudeJsonPath = join(homedir(), '.claude.json')
      const content = await readFile(claudeJsonPath, 'utf8')
      const parsed = JSON.parse(content)
      if (parsed.primaryApiKey) {
        this.store.anthropicApiKey = parsed.primaryApiKey
        this.store.activeProvider = 'anthropic'
        this.store.primaryModel = 'claude-3-7-sonnet-20250219'
        this.store.secondaryModel = 'claude-3-5-haiku-20241022'
      }
    } catch {
      // Ignore if not present
    }

    await this.save()
  }

  async save(): Promise<void> {
    await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 })
    await writeFile(CRED_FILE, JSON.stringify(this.store, null, 2), { mode: 0o600 })
  }

  getStore(): CredentialsStore {
    return { ...this.store }
  }

  setProvider(provider: ProviderType, apiKey?: string): void {
    this.store.activeProvider = provider
    if (provider === 'anthropic' && apiKey) this.store.anthropicApiKey = apiKey
    if (provider === 'openai' && apiKey) this.store.openaiApiKey = apiKey
    if (provider === 'google' && apiKey) this.store.googleApiKey = apiKey

    if (provider === 'google') {
      this.store.primaryModel = 'gemini-3.6-flash'
      this.store.secondaryModel = 'gemini-3.5-flash-lite'
    } else if (provider === 'anthropic') {
      this.store.primaryModel = 'claude-3-7-sonnet-20250219'
      this.store.secondaryModel = 'claude-3-5-haiku-20241022'
    } else if (provider === 'openai') {
      this.store.primaryModel = 'gpt-4o'
      this.store.secondaryModel = 'gpt-4o-mini'
    }
    void this.save()
  }

  setModels(primary: string, secondary?: string): void {
    this.store.primaryModel = primary
    if (secondary) this.store.secondaryModel = secondary
    void this.save()
  }
}
