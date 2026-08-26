import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

type CuppetOpenAIOAuth = {
  type: 'oauth'
  access: string
  refresh: string
  expires: number
  accountId: string
}

type CuppetAuthFile = {
  openai?: unknown
}

export type DshCredentialDocument = {
  version: 1
  records: {
    'llm-pi-ai/openai-codex': {
      kind: 'grant'
      payload: CuppetOpenAIOAuth
    }
  }
}

export type StagedCuppetOpenAICodexCredentials = {
  dshHome: string
  cleanup(): Promise<void>
}

const DEFAULT_CUPPET_AUTH_FILE = join(
  homedir(),
  '.cuppet',
  'v2',
  'opencode',
  'data',
  'opencode',
  'auth.json',
)

export function buildDshOpenAICodexCredentialDocument(auth: unknown): DshCredentialDocument {
  if (!isRecord(auth)
    || auth.type !== 'oauth'
    || typeof auth.access !== 'string'
    || typeof auth.refresh !== 'string'
    || typeof auth.expires !== 'number'
    || !Number.isFinite(auth.expires)
    || typeof auth.accountId !== 'string') {
    throw new Error('Cuppet OpenAI auth does not contain a usable OAuth grant')
  }
  return {
    version: 1,
    records: {
      'llm-pi-ai/openai-codex': {
        kind: 'grant',
        payload: {
          type: 'oauth',
          access: auth.access,
          refresh: auth.refresh,
          expires: auth.expires,
          accountId: auth.accountId,
        },
      },
    },
  }
}

export async function stageCuppetOpenAICodexCredentials(
  authFile = process.env.CUPPET_OPENAI_AUTH_FILE ?? DEFAULT_CUPPET_AUTH_FILE,
): Promise<StagedCuppetOpenAICodexCredentials> {
  const source = JSON.parse(await readFile(authFile, 'utf8')) as CuppetAuthFile
  const document = buildDshOpenAICodexCredentialDocument(source.openai)
  const dshHome = await mkdtemp(join('/private/tmp', 'cuppet-dsh-openai-'))
  try {
    await writeFile(join(dshHome, '.credentials.yaml'), `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
  } catch (error) {
    await rm(dshHome, { recursive: true, force: true })
    throw error
  }
  return {
    dshHome,
    cleanup: () => rm(dshHome, { recursive: true, force: true }),
  }
}

export async function withCuppetOpenAICodexCredentials<T>(
  run: (dshHome: string) => Promise<T>,
  authFile = process.env.CUPPET_OPENAI_AUTH_FILE ?? DEFAULT_CUPPET_AUTH_FILE,
): Promise<T> {
  const staged = await stageCuppetOpenAICodexCredentials(authFile)
  try {
    return await run(staged.dshHome)
  } finally {
    await staged.cleanup()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
