import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const binary = process.env.CUPPET_TURA_BIN?.trim() || 'tura'
const expectedModel = process.env.CUPPET_TURA_MODEL?.trim() || 'openai/gpt-5.6-luna'
const expectedReasoning = process.env.CUPPET_TURA_REASONING?.trim() || 'low'
const [expectedProvider, expectedModelID] = expectedModel.split('/', 2)
if (!expectedProvider || !expectedModelID) throw new Error(`invalid Tura model: ${expectedModel}`)

const help = await execFile(binary, ['exec', '--help'], { maxBuffer: 256 * 1024 })
const requiredFlags = ['--session-id', '--model', '--agent-id', '--model-reasoning-effort', '--json', '--sandbox']
for (const flag of requiredFlags) if (!help.stdout.includes(flag)) throw new Error(`Tura exec help does not expose ${flag}`)

const status = await execFile(binary, ['provider', 'status', 'openai', '--json'], { maxBuffer: 1024 * 1024, env: process.env })
const auth = JSON.parse(status.stdout) as { authenticated?: boolean; auth_state?: string; runtime_state?: string }
if (!auth.authenticated || auth.auth_state !== 'authenticated' || auth.runtime_state !== 'ready') {
  throw new Error(`Tura OpenAI auth is not ready: ${JSON.stringify(auth)}`)
}

const providers = await execFile(binary, ['provider', 'list', '--json'], { maxBuffer: 8 * 1024 * 1024, env: process.env })
const catalog = JSON.parse(providers.stdout) as { all?: Array<{ id?: string; models?: Record<string, unknown> }> }
const openai = catalog.all?.find((provider) => provider.id === expectedProvider)
if (!openai?.models?.[expectedModelID]) throw new Error(`Tura provider catalog does not expose ${expectedModel}`)

process.stdout.write(`${JSON.stringify({
  binary,
  version: process.env.CUPPET_TURA_VERSION ?? 'unreported',
  mode: 'direct',
  model: expectedModel,
  reasoningEffort: expectedReasoning,
  authenticated: true,
  nativeSessionFlags: requiredFlags,
  modelRequest: 'not sent',
}, null, 2)}\n`)
