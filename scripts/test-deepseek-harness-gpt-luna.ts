import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { withCuppetOpenAICodexCredentials } from './lib/cuppet-openai-codex.js'
import { DEEPSEEK_HARNESS_CODING_SYSTEM_PROMPT, runDeepSeekHarness } from './lib/deepseek-harness.js'

const workspace = await mkdtemp(join('/private/tmp', 'cuppet-dsh-gpt-luna-'))
const project = resolve(process.cwd())
const model = 'gpt-5.6-luna'

try {
  await mkdir(join(workspace, 'src'))
  await writeFile(join(workspace, 'src', 'value.ts'), 'export const value = 1\n')
  const startedAt = Date.now()
  const result = await withCuppetOpenAICodexCredentials((dshHome) => runDeepSeekHarness({
    workspace,
    sessionRoot: join(dshHome, 'sessions'),
    harnessRoot: join(project, '.benchmarks', 'deepseek-harness'),
    cordisConfig: join(project, 'benchmarks', 'configs', 'deepseek-harness-openai-codex.cordis.yml'),
    dshHome,
    provider: 'openai-codex',
    model,
    maxTokens: 4096,
    requestTimeoutMs: 180_000,
    systemPrompt: DEEPSEEK_HARNESS_CODING_SYSTEM_PROMPT,
  }, 'Edit src/value.ts so the exported value is 42. Use str_replace_editor, then reply exactly LUNA_DSH_OK.'))
  const edited = await readFile(join(workspace, 'src', 'value.ts'), 'utf8')
  if (edited !== 'export const value = 42\n') {
    throw new Error(`GPT-5.6 Luna did not make the expected edit: ${JSON.stringify(edited)}`)
  }
  console.log(JSON.stringify({
    passed: true,
    provider: 'openai-codex',
    model,
    durationMs: Date.now() - startedAt,
    answer: result.answer,
    usage: result.usage,
  }, null, 2))
} finally {
  await rm(workspace, { recursive: true, force: true })
}
