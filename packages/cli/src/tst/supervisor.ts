import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { isWindows, pickLoopbackPort } from '../runtime/ipc.js'
import type { RuntimePaths } from '../runtime/paths.js'
import type { RedactedLogger } from '../runtime/logger.js'
import { TstClient } from './client.js'

export type TstRuntime = {
  client: TstClient
  socket: string
  token: string
  close(): Promise<void>
}

export async function startTstDaemon(
  binary: string,
  paths: RuntimePaths,
  logger: RedactedLogger,
): Promise<TstRuntime> {
  const token = randomBytes(32).toString('hex')
  // Windows has no Unix-domain sockets: run the daemon on a supervisor-picked
  // loopback TCP port. macOS/Linux keep the private socket file.
  if (isWindows) {
    const port = await pickLoopbackPort()
    const endpoint = `127.0.0.1:${port}`
    const child = spawnDaemon(binary, ['--host', '127.0.0.1', '--port', String(port), ...storeArguments(paths)], token, logger)
    return wrapDaemon(child, endpoint, token)
  }
  const child = spawnDaemon(binary, ['--socket', paths.tstSocket, ...storeArguments(paths)], token, logger)
  return wrapDaemon(child, paths.tstSocket, token)
}

function storeArguments(paths: RuntimePaths): string[] {
  return [
    '--project-root',
    paths.projectRealpath,
    '--project-store',
    paths.projectStore,
    '--global-store',
    paths.globalStore,
  ]
}

function spawnDaemon(
  binary: string,
  arguments_: string[],
  token: string,
  logger: RedactedLogger,
): ChildProcess {
  const child = spawn(
    binary,
    arguments_,
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, CUPPET_TST_TOKEN: token },
    },
  )
  child.stderr?.on('data', (chunk: Buffer) => void logger.write('warn', `tst: ${chunk.toString('utf8')}`))
  return child
}

async function wrapDaemon(child: ChildProcess, endpoint: string, token: string): Promise<TstRuntime> {
  try {
    const client = await waitForClient(child, endpoint, token)
    return {
      client,
      socket: endpoint,
      token,
      async close() {
        try {
          await Promise.race([
            client.call('shutdown'),
            new Promise((resolve) => setTimeout(resolve, 1_500)),
          ])
        } finally {
          client.destroy()
          if (child.exitCode === null) child.kill('SIGTERM')
          await waitForExit(child)
        }
      },
    }
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGTERM')
    await waitForExit(child)
    throw error
  }
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve()
    }, 5_000)
    const onExit = () => {
      clearTimeout(timer)
      resolve()
    }
    child.once('exit', onExit)
  })
}

async function waitForClient(child: ChildProcess, socket: string, token: string): Promise<TstClient> {
  const deadline = Date.now() + 10_000
  let lastError: Error | undefined
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`TST daemon exited with code ${child.exitCode}`)
    try {
      return await TstClient.connect(socket, token)
    } catch (error) {
      lastError = error as Error
      await new Promise((resolve) => setTimeout(resolve, 75))
    }
  }
  throw new Error(`Timed out waiting for TST daemon: ${lastError?.message ?? 'socket unavailable'}`)
}
