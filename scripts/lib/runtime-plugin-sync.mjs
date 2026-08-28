import { createHash } from 'node:crypto'
import { access, copyFile, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export async function refreshRuntimePlugins(runtime, plugin = resolve('packages', 'opencode-plugin', 'dist')) {
  const manifestPath = resolve(runtime, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const name of ['index.js', 'server.js', 'tui.js']) {
    const source = resolve(plugin, name)
    const destination = resolve(runtime, 'plugin', name)
    await access(source)
    await copyFile(source, destination)
    manifest.files[`plugin/${name}`] = createHash('sha256').update(await readFile(destination)).digest('hex')
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}
