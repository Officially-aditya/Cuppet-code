import { createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type RuntimePaths = Awaited<ReturnType<typeof createRuntimePaths>>

export async function createRuntimePaths(
  projectDirectory: string,
  baseDirectory = join(homedir(), '.cuppet', 'v2'),
) {
  const projectRealpath = await realpath(projectDirectory)
  const base = baseDirectory
  const projectID = createHash('sha256').update(projectRealpath).digest('hex')
  const launchID = `${process.pid}-${randomBytes(8).toString('hex')}`
  const runtime = join(base, 'run', launchID)
  const paths = {
    base,
    projectRealpath,
    projectID,
    projectStore: join(base, 'projects', projectID),
    globalStore: join(base, 'global'),
    preferences: join(base, 'preferences.json'),
    logs: join(base, 'logs'),
    runtime,
    tstSocket: join(runtime, 'tst.sock'),
    opencode: {
      config: join(base, 'opencode', 'config'),
      data: join(base, 'opencode', 'data'),
      cache: join(base, 'opencode', 'cache'),
      state: join(base, 'opencode', 'state'),
    },
  }
  const privateDirectories = [
    base,
    paths.projectStore,
    paths.globalStore,
    paths.logs,
    runtime,
    paths.opencode.config,
    paths.opencode.data,
    paths.opencode.cache,
    paths.opencode.state,
  ]
  await Promise.all(privateDirectories.map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })))
  await Promise.all(privateDirectories.map((directory) => chmod(directory, 0o700)))
  return paths
}
