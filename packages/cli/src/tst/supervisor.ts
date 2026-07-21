import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
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
  const child = spawn(
    binary,
    [
      '--socket',
      paths.tstSocket,
      '--project-root',
      paths.projectRealpath,
      '--project-store',
      paths.projectStore,
      '--global-store',
      paths.globalStore,
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, CUPPET_TST_TOKEN: token },
    },
  )
  child.stderr?.on('data', (chunk: Buffer) => void logger.write('warn', `tst: ${chunk.toString('utf8')}`))

  try {
    const client = await waitForClient(child, paths.tstSocket, token)
    return {
      client,
      socket: paths.tstSocket,
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
        }
      },
    }
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGTERM')
    throw error
  }
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
