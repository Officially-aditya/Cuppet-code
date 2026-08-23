import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimePaths } from '../runtime/paths.js'

/**
 * Orchestrator mode is a runtime toggle shared between the CLI controller
 * (writer), the TUI (via control RPC), and the OpenCode server plugin
 * (reader). The plugin lives in a different process, so the flag travels
 * through this small state file in the launch-scoped runtime directory.
 */
export function orchestratorStatePath(paths: Pick<RuntimePaths, 'runtime'>): string {
  return join(paths.runtime, 'orchestrator.json')
}

export function readOrchestratorState(paths: Pick<RuntimePaths, 'runtime'>): boolean | undefined {
  try {
    const parsed = JSON.parse(readFileSync(orchestratorStatePath(paths), 'utf8')) as { enabled?: unknown }
    return typeof parsed.enabled === 'boolean' ? parsed.enabled : undefined
  } catch {
    return undefined
  }
}

export async function writeOrchestratorState(paths: Pick<RuntimePaths, 'runtime'>, enabled: boolean): Promise<void> {
  const path = orchestratorStatePath(paths)
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify({ schema: 1, enabled })}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}
