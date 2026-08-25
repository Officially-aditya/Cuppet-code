import { cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RuntimePaths } from '../../packages/cli/src/runtime/paths.js'

export type CuppetOpenCodeStateFile = {
  source: string
  target: string
}

export function resolveCuppetOpenCodeStateFiles(
  persistentRoot: string,
  paths: Pick<RuntimePaths, 'opencode'>,
): CuppetOpenCodeStateFile[] {
  return [
    {
      source: join(persistentRoot, 'data', 'opencode', 'auth.json'),
      target: join(paths.opencode.data, 'opencode', 'auth.json'),
    },
    {
      source: join(persistentRoot, 'data', 'opencode', 'opencode.db'),
      target: join(paths.opencode.data, 'opencode', 'opencode.db'),
    },
    {
      source: join(persistentRoot, 'data', 'opencode', 'opencode.db-wal'),
      target: join(paths.opencode.data, 'opencode', 'opencode.db-wal'),
    },
    {
      source: join(persistentRoot, 'data', 'opencode', 'opencode.db-shm'),
      target: join(paths.opencode.data, 'opencode', 'opencode.db-shm'),
    },
    {
      source: join(persistentRoot, 'cache', 'opencode', 'models.json'),
      target: join(paths.opencode.cache, 'opencode', 'models.json'),
    },
  ]
}

export async function seedCuppetOpenCodeProviderState(
  paths: Pick<RuntimePaths, 'opencode'>,
): Promise<void> {
  const persistentRoot = join(process.env.HOME ?? '', '.cuppet', 'v2', 'opencode')
  for (const file of resolveCuppetOpenCodeStateFiles(persistentRoot, paths)) {
    try {
      await mkdir(dirname(file.target), { recursive: true, mode: 0o700 })
      await cp(file.source, file.target, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

