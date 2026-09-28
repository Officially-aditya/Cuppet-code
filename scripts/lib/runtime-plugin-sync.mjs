import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const defaultPlugin = (...segments) => resolve(repositoryRoot, 'packages', 'opencode-plugin', 'dist', ...segments)

export async function refreshRuntimePlugins(runtime, plugin = resolve(repositoryRoot, 'packages', 'opencode-plugin', 'dist')) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(resolve(runtime, 'manifest.json'), 'utf8'))
  } catch (error) {
    throw new Error(
      `runtime manifest is unreadable at ${resolve(runtime, 'manifest.json')}: ${error.code ?? error.message ?? error}; run package:platform before install:global`,
    )
  }
  if (!manifest.files || typeof manifest.files !== 'object') manifest.files = {}
  for (const name of ['index.js', 'server.js', 'tui.js']) {
    const source = resolve(plugin, name)
    const destination = resolve(runtime, 'plugin', name)
    try {
      await access(source)
    } catch {
      throw new Error(
        `plugin build is missing at ${source}; run npm ci && npm run build, then re-run npm run install:global`,
      )
    }
    try {
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source, destination)
    } catch (error) {
      throw new Error(
        `unable to refresh runtime plugin ${name} (${source} -> ${destination}): ${error.code ?? error.message ?? error}`,
      )
    }
    manifest.files[`plugin/${name}`] = createHash('sha256').update(await readFile(destination)).digest('hex')
  }
  await writeFile(resolve(runtime, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

export { defaultPlugin }
