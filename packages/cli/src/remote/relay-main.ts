import { generateSecret } from './relay.js'
import { CuppetRelay } from './relay.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type RelayServerArguments = {
  port: number
  authFile?: string
  appDir?: string
  adminToken?: string
  origins: string[]
}

export const DEFAULT_RELAY_PORT = 8787

export function defaultRelayAuthPath(): string {
  return join(process.cwd(), 'cuppet-relay-auth.json')
}

/**
 * Locate the bundled remote-control PWA without hard-coding a layout:
 * dev runs from src/remote/, packaged builds ship it as relay-app/.
 */
export async function defaultAppDir(): Promise<string | undefined> {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [join(moduleDir, 'app'), join(moduleDir, '../src/remote/app'), join(moduleDir, '../relay-app')]
  for (const candidate of candidates) {
    try {
      await readFile(join(candidate, 'index.html'))
      return candidate
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

/**
 * Long-running relay process: `cuppet relay --port 8787 --auth-file …`.
 * Routes envelopes between hosts and devices and serves the PWA under /app.
 * Persists no transcripts — see relay.ts for the privacy posture.
 */
export async function runRelayServer(
  options: RelayServerArguments,
  write: (line: string) => void = (line) => process.stdout.write(line),
): Promise<void> {
  const authFile = options.authFile
  if (authFile && !(await fileExists(authFile))) {
    await mkdir(resolve(authFile, '..'), { recursive: true, mode: 0o700 })
    await writeFile(authFile, `${JSON.stringify({ hosts: {} }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    write(`relay auth: created ${authFile}\n`)
  }

  const token = options.adminToken ?? generateSecret()
  const appDir = options.appDir ? resolve(options.appDir) : await defaultAppDir()
  const relay = new CuppetRelay({
    port: options.port,
    ...(authFile ? { authFile } : {}),
    ...(appDir ? { appDirectory: appDir } : {}),
    adminToken: token,
    ...(options.origins.length > 0 ? { allowedOrigins: options.origins } : {}),
  })
  await relay.listen(options.port)
  write(`Cuppet relay listening on port ${relay.port}\n`)
  write(`  health: http://0.0.0.0:${relay.port}/healthz\n`)
  if (!authFile) {
    write('  WARNING: no --auth-file set — host authentication is disabled (development mode).\n')
  }
  if (options.adminToken) {
    write(`  manage hosts: POST/DELETE /hosts with Authorization: Bearer <admin-token>\n`)
  } else {
    write(`  admin token (for POST /hosts enrollment): ${token}\n`)
    write('  pass --admin-token to pin it instead of generating one per start\n')
  }
  if (appDir) {
    write(`  pwa: http://0.0.0.0:${relay.port}/app\n`)
  }
  await shutdownSignal()
  relay.close()
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

/** Resolves when SIGINT/SIGTERM is received; second signal forces exit. */
export function shutdownSignal(): Promise<void> {
  return new Promise((resolvePromise) => {
    let signaled = false
    const onSignal = (): void => {
      if (signaled) process.exit(130)
      signaled = true
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
      resolvePromise()
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
  })
}
