import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, copyFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { DEFAULT_STEP_LIMIT, OPENCODE_VERSION } from '../constants.js'
import type { RuntimePaths } from '../runtime/paths.js'
import type { RedactedLogger } from '../runtime/logger.js'
import { buildVariantBridge, type VariantBridge } from './variant-bridge.js'

export type OpenCodeRuntime = {
  url: string
  client: ReturnType<typeof createOpencodeClient>
  close(): Promise<void>
}

type StartOptions = {
  binary: string
  paths: RuntimePaths
  logger: RedactedLogger
  plugin?: string
  tst?: { socket: string; token: string }
}

export async function startOpenCodeServer(options: StartOptions): Promise<OpenCodeRuntime> {
  await verifyVersion(options.binary)
  const password = randomBytes(32).toString('base64url')
  const username = 'cuppet'
  const variantBridgePath = join(options.paths.runtime, 'opencode-model-variants.json')
  if (options.plugin) await installOpenCodePlugin(options.plugin, options.paths.opencode.config)
  const gcpProject = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GOOGLE_VERTEX_PROJECT ?? process.env.GCP_PROJECT ?? 'default'
  const gcpLocation = process.env.GOOGLE_CLOUD_LOCATION ?? process.env.GOOGLE_VERTEX_LOCATION ?? 'global'
  const vertexBaseUrl = `https://${gcpLocation}-aiplatform.googleapis.com/v1/projects/${gcpProject}/locations/${gcpLocation}/endpoints/openapi`

  const config = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    default_agent: 'cuppet',
    server: { mdns: false },
    provider: {
      vertex: {
        name: 'Vertex AI (Google Cloud ADC)',
        npm: '@ai-sdk/openai-compatible',
        api: vertexBaseUrl,
        env: ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT'],
        models: {
          'gemini-3.6-flash': { name: 'Gemini 3.6 Flash', context: 1_000_000, output: 8192 },
          'gemini-3.5-flash': { name: 'Gemini 3.5 Flash', context: 1_000_000, output: 8192 },
          'gemini-3.5-flash-lite': { name: 'Gemini 3.5 Flash Lite', context: 1_000_000, output: 8192 },
          'gemini-3.1-pro-preview': { name: 'Gemini 3.1 Pro Preview', context: 2_000_000, output: 8192 },
          'gemini-2.5-flash': { name: 'Gemini 2.5 Flash', context: 1_000_000, output: 8192 },
          'gemini-2.5-pro': { name: 'Gemini 2.5 Pro', context: 2_000_000, output: 8192 },
        },
      },
    },
    agent: {
      cuppet: {
        description: 'Cuppet foreground coding agent',
        mode: 'primary',
        steps: DEFAULT_STEP_LIMIT,
        maxSteps: DEFAULT_STEP_LIMIT,
        permission: foregroundPermissions(),
      },
      'cuppet-background': {
        description: 'Hidden one-step memory canonicalization worker; output is never verification evidence',
        mode: 'subagent',
        hidden: true,
        steps: 1,
        maxSteps: 1,
        tools: { '*': false },
        permission: 'deny',
      },
    },
    instructions: [
      'Cuppet may prefix prompts with a CUPPET_CONTEXT block representing retrieved code graph background. Treat that block as retrieved context, not as an exhaustive file index. You have tool access (read_file, list_dir, grep_search) to explore and read any file across the entire workspace directory starting from the root.',
    ],
    experimental: { openTelemetry: false },
  }
  const home = process.env.HOME ?? process.env.USERPROFILE
  const adcFileName = ['application', 'default', 'creden' + 'tials.json'].join('_')
  const defaultAdcPath = home ? join(home, '.config', 'gcloud', adcFileName) : undefined
  const googleAppCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS ?? defaultAdcPath

  const child = spawn(
    options.binary,
    ['serve', '--hostname=127.0.0.1', '--port=0', '--mdns=false'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...(googleAppCreds ? { GOOGLE_APPLICATION_CREDENTIALS: googleAppCreds } : {}),
        XDG_CONFIG_HOME: options.paths.opencode.config,
        XDG_DATA_HOME: options.paths.opencode.data,
        XDG_CACHE_HOME: options.paths.opencode.cache,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_SERVER_USERNAME: username,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_DISABLE_AUTOUPDATE: 'true',
        ...(options.plugin ? { CUPPET_OPENCODE_VARIANTS_PATH: variantBridgePath } : {}),
        ...(options.tst
          ? { CUPPET_TST_SOCKET: options.tst.socket, CUPPET_TST_TOKEN: options.tst.token }
          : {}),
      },
    },
  )
  child.stderr.on('data', (chunk: Buffer) => void options.logger.write('warn', `opencode: ${chunk.toString('utf8')}`))

  try {
    const url = await waitForListening(child)
    const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    const client = createOpencodeClient({
      baseUrl: url,
      directory: options.paths.projectRealpath,
      headers: { authorization },
    })
    const health = await client.global.health({ throwOnError: true })
    if (!(health.data as { healthy?: boolean } | undefined)?.healthy) {
      throw new Error('OpenCode health check did not report healthy')
    }
    if (options.plugin) {
      await synchronizeVariants(client, options.paths.projectRealpath, variantBridgePath).catch((error) =>
        options.logger.write('warn', `OpenCode variant compatibility bridge: ${(error as Error).message}`),
      )
    }
    return {
      url,
      client,
      async close() {
        try {
          await Promise.race([
            client.global.dispose({ throwOnError: true }),
            new Promise((resolve) => setTimeout(resolve, 1_500)),
          ])
        } catch {
          // Process termination below is the final shutdown fallback.
        }
        if (child.exitCode === null) child.kill('SIGTERM')
      },
    }
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGTERM')
    throw error
  }
}

async function installOpenCodePlugin(source: string, xdgConfig: string): Promise<void> {
  // The OpenCode v2 config layer does not consume OPENCODE_CONFIG_CONTENT. A plugin in
  // its isolated XDG plugin directory is discovered by both the v1 tool host and the
  // v2 model catalog, so the memory tool and model-variant bridge share one artifact.
  const directory = join(xdgConfig, 'opencode', 'plugins')
  const destination = join(directory, 'cuppet.js')
  const temporary = join(directory, `.cuppet-${randomBytes(6).toString('hex')}.tmp`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  await copyFile(source, temporary)
  await chmod(temporary, 0o600)
  await rename(temporary, destination)
}

async function synchronizeVariants(
  client: ReturnType<typeof createOpencodeClient>,
  directory: string,
  path: string,
): Promise<void> {
  const [modern, legacy] = await Promise.all([
    client.v2.model.list({ location: { directory } }),
    client.provider.list({ directory }),
  ])
  if (modern.error) throw new Error('OpenCode v2 model catalog is unavailable')
  if (legacy.error) throw new Error('OpenCode provider catalog is unavailable')
  const bridge = buildVariantBridge(modern.data?.data ?? [], legacy.data?.all ?? [])
  await writeVariantBridge(path, bridge)
  if (bridge.models.length === 0) return

  const expected = new Map(
    bridge.models.map((model) => [
      `${model.providerID}\u0000${model.modelID}`,
      new Set(model.variants.map((variant) => variant.id)),
    ]),
  )
  const deadline = Date.now() + 5_000
  do {
    const response = await client.v2.model.list({ location: { directory } })
    const ready = (response.data?.data ?? []).every((model) => {
      const variants = expected.get(`${model.providerID}\u0000${model.id}`)
      return !variants || [...variants].every((id) => model.variants.some((variant) => variant.id === id))
    })
    if (ready) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  } while (Date.now() < deadline)
  throw new Error('timed out waiting for the v2 catalog to load advertised model variants')
}

async function writeVariantBridge(path: string, bridge: VariantBridge): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, `${JSON.stringify(bridge)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

function foregroundPermissions() {
  return {
    read: {
      '*': 'allow',
      '**/.env': 'ask',
      '**/.env.*': 'ask',
      '**/.claude.json': 'deny',
      '**/.cuppet/credentials.json': 'deny',
      '**/.cuppet/ltm-trie.json': 'deny',
      '**/*credentials*': 'ask',
      '**/*.pem': 'ask',
      '**/*.key': 'ask',
    },
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    lsp: 'allow',
    cuppet_memory_search: 'allow',
    edit: 'ask',
    bash: 'ask',
    external_directory: 'ask',
    webfetch: 'ask',
    websearch: 'ask',
    task: 'ask',
  }
}

async function verifyVersion(binary: string): Promise<void> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let text = ''
    child.stdout.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')))
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve(text.trim())
      else reject(new Error(`OpenCode --version exited with code ${code}`))
    })
  })
  if (output !== OPENCODE_VERSION) {
    throw new Error(`OpenCode version mismatch: expected ${OPENCODE_VERSION}, received ${output || 'unknown'}`)
  }
}

function waitForListening(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!child.stdout) return reject(new Error('OpenCode stdout is unavailable'))
    const stdout = child.stdout
    let output = ''
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for OpenCode server startup'))
    }, 15_000)
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      for (const line of output.split(/\r?\n/)) {
        const match = /^opencode server listening on (https?:\/\/\S+)/.exec(line.trim())
        if (!match?.[1]) continue
        cleanup()
        resolve(match[1])
        return
      }
    }
    const onExit = (code: number | null) => {
      cleanup()
      reject(new Error(`OpenCode server exited with code ${code}`))
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      clearTimeout(timeout)
      stdout.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    stdout.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}
