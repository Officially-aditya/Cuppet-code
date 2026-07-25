import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OPENCODE_REVISION, OPENCODE_VERSION, TST_PROTOCOL_VERSION } from '../constants.js'

type RuntimeManifest = {
  schema: 1
  platform: string
  arch: string
  libc: 'glibc' | null
  opencodeVersion: string
  opencodeRevision: string
  sdkVersion: string
  tstProtocol: string
  files: Record<string, string>
}

export type RuntimeAssets = {
  source: 'package' | 'development'
  opencode?: string | undefined
  tst?: string | undefined
  plugin?: string | undefined
  manifest?: RuntimeManifest | undefined
  diagnostics: string[]
}

const packageNames: Record<string, string> = {
  'darwin-arm64': '@cuppet/runtime-darwin-arm64',
  'darwin-x64': '@cuppet/runtime-darwin-x64',
  'linux-arm64': '@cuppet/runtime-linux-arm64-gnu',
  'linux-x64': '@cuppet/runtime-linux-x64-gnu',
}

export async function resolveRuntimeAssets(): Promise<RuntimeAssets> {
  const diagnostics: string[] = []
  const opencodeOverride = process.env.CUPPET_OPENCODE_BIN
  const tstOverride = process.env.CUPPET_TST_BIN
  const pluginOverride = process.env.CUPPET_PLUGIN_PATH
  if (opencodeOverride || tstOverride || pluginOverride) {
    const assets: RuntimeAssets = {
      source: 'development',
      diagnostics,
      ...(opencodeOverride ? { opencode: resolve(opencodeOverride) } : {}),
      ...(tstOverride ? { tst: resolve(tstOverride) } : {}),
      ...(pluginOverride ? { plugin: resolve(pluginOverride) } : {}),
    }
    await fillDevelopmentDefaults(assets)
    await checkPresence(assets)
    return assets
  }

  const key = `${process.platform}-${process.arch}`
  const packageName = packageNames[key]
  if (!packageName) {
    return { source: 'package', diagnostics: [`Unsupported platform ${key}`] }
  }
  try {
    const require = createRequire(import.meta.url)
    const manifestPath = require.resolve(`${packageName}/manifest.json`)
    const root = dirname(manifestPath)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as RuntimeManifest
    validateManifest(manifest)
    const assets: RuntimeAssets = {
      source: 'package',
      opencode: join(root, 'bin', 'opencode'),
      tst: join(root, 'bin', 'tst-daemon'),
      plugin: join(root, 'plugin', 'index.js'),
      manifest,
      diagnostics,
    }
    await verifyChecksums(root, manifest)
    await checkPresence(assets)
    return assets
  } catch (error) {
    const packageDiagnostic = `Runtime package unavailable or invalid: ${(error as Error).message}`
    const assets: RuntimeAssets = { source: 'development', diagnostics }
    await fillDevelopmentDefaults(assets)
    await checkPresence(assets)
    if (!assets.opencode) diagnostics.unshift(packageDiagnostic)
    return assets
  }
}

async function fillDevelopmentDefaults(assets: RuntimeAssets): Promise<void> {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const repositoryRoot = await findRepositoryRoot(moduleDirectory)
  const key = `${process.platform}-${process.arch}`
  const packageName = packageNames[key]
  const runtimeDirectory = runtimeDirectories[key]
  const localRuntimeCandidate = repositoryRoot && runtimeDirectory
    ? resolve(repositoryRoot, 'artifacts', runtimeDirectory)
    : undefined
  const localRuntime = localRuntimeCandidate && await verifyLocalRuntime(localRuntimeCandidate, assets.diagnostics)
    ? localRuntimeCandidate
    : undefined

  let globalPackageRoot: string | undefined
  if (packageName) {
    try {
      const require = createRequire(import.meta.url)
      const manifestPath = require.resolve(`${packageName}/manifest.json`)
      globalPackageRoot = dirname(manifestPath)
    } catch {
      // Ignore if package cannot be resolved
    }
  }

  const pathOpencode = await findInPath('opencode')
  const pathTst = await findInPath('tst-daemon')

  const candidates = {
    opencode: [
      ...(localRuntime ? [resolve(localRuntime, 'bin/opencode')] : []),
      ...(repositoryRoot && runtimeDirectory ? [resolve(repositoryRoot, 'packages', runtimeDirectory, 'bin/opencode')] : []),
      ...(globalPackageRoot ? [resolve(globalPackageRoot, 'bin/opencode')] : []),
      ...(pathOpencode ? [pathOpencode] : []),
    ],
    tst: [
      resolve(process.cwd(), 'target/release/tst-daemon'),
      resolve(process.cwd(), 'target/debug/tst-daemon'),
      ...(localRuntime ? [resolve(localRuntime, 'bin/tst-daemon')] : []),
      ...(repositoryRoot ? [
        resolve(repositoryRoot, 'target/release/tst-daemon'),
        resolve(repositoryRoot, 'target/debug/tst-daemon'),
      ] : []),
      ...(repositoryRoot && runtimeDirectory ? [resolve(repositoryRoot, 'packages', runtimeDirectory, 'bin/tst-daemon')] : []),
      ...(globalPackageRoot ? [resolve(globalPackageRoot, 'bin/tst-daemon')] : []),
      ...(pathTst ? [pathTst] : []),
    ],
    plugin: [
      resolve(process.cwd(), 'packages/opencode-plugin/dist/index.js'),
      ...(localRuntime ? [resolve(localRuntime, 'plugin/index.js')] : []),
      ...(repositoryRoot ? [resolve(repositoryRoot, 'packages/opencode-plugin/dist/index.js')] : []),
      ...(repositoryRoot && runtimeDirectory ? [resolve(repositoryRoot, 'packages', runtimeDirectory, 'plugin/index.js')] : []),
      ...(globalPackageRoot ? [resolve(globalPackageRoot, 'plugin/index.js')] : []),
    ],
  }
  if (!assets.opencode) assets.opencode = await firstExisting(candidates.opencode)
  if (!assets.tst) assets.tst = await firstExisting(candidates.tst)
  if (!assets.plugin) assets.plugin = await firstExisting(candidates.plugin)
}

async function findInPath(binaryName: string): Promise<string | undefined> {
  const pathEnv = process.env.PATH
  if (!pathEnv) return undefined
  const directories = pathEnv.split(delimiter)
  for (const directory of directories) {
    if (!directory) continue
    const candidate = join(directory, binaryName)
    try {
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue searching PATH
    }
  }
  return undefined
}

const runtimeDirectories: Record<string, string> = {
  'darwin-arm64': 'runtime-darwin-arm64',
  'darwin-x64': 'runtime-darwin-x64',
  'linux-arm64': 'runtime-linux-arm64-gnu',
  'linux-x64': 'runtime-linux-x64-gnu',
}

async function verifyLocalRuntime(root: string, diagnostics: string[]): Promise<boolean> {
  const manifestPath = resolve(root, 'manifest.json')
  try {
    await access(manifestPath, constants.R_OK)
  } catch {
    return false
  }
  try {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as RuntimeManifest
    validateManifest(manifest)
    await verifyChecksums(root, manifest)
    return true
  } catch (error) {
    diagnostics.push(`Local runtime artifact is invalid: ${(error as Error).message}`)
    return false
  }
}

async function findRepositoryRoot(start: string): Promise<string | undefined> {
  let directory = start
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const metadata = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8')) as { name?: string }
      if (metadata.name === 'cuppet-monorepo') return directory
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

async function checkPresence(assets: RuntimeAssets): Promise<void> {
  for (const [label, path, mode] of [
    ['OpenCode', assets.opencode, constants.X_OK],
    ['TST daemon', assets.tst, constants.X_OK],
    ['memory plugin', assets.plugin, constants.R_OK],
  ] as const) {
    if (!path) {
      assets.diagnostics.push(`${label} path is not configured`)
      continue
    }
    try {
      await access(path, mode)
    } catch {
      assets.diagnostics.push(`${label} missing at ${path}`)
      if (label === 'OpenCode') assets.opencode = undefined
      if (label === 'TST daemon') assets.tst = undefined
      if (label === 'memory plugin') assets.plugin = undefined
    }
  }
}

function validateManifest(manifest: RuntimeManifest): void {
  if (
    manifest.schema !== 1 ||
    manifest.opencodeVersion !== OPENCODE_VERSION ||
    manifest.sdkVersion !== OPENCODE_VERSION ||
    manifest.opencodeRevision !== OPENCODE_REVISION ||
    manifest.tstProtocol !== TST_PROTOCOL_VERSION
  ) {
    throw new Error('runtime manifest is incompatible with this Cuppet release')
  }
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error('runtime manifest targets a different platform')
  }
  if (process.platform === 'linux') {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } }
    const header = report.header ?? {}
    if (manifest.libc !== 'glibc' || !header.glibcVersionRuntime) {
      throw new Error('Cuppet alpha requires a glibc Linux runtime')
    }
  } else if (manifest.libc !== null) {
    throw new Error('non-Linux runtime manifest must not declare a libc')
  }
}

async function verifyChecksums(root: string, manifest: RuntimeManifest): Promise<void> {
  const required = ['bin/opencode', 'bin/tst-daemon', 'plugin/index.js']
  for (const relative of required) {
    const expected = manifest.files[relative]
    if (!expected) throw new Error(`manifest has no checksum for ${relative}`)
    const actual = await sha256(join(root, relative))
    if (actual !== expected) throw new Error(`checksum mismatch for ${relative}`)
  }
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await access(path)
      return path
    } catch {
      // Try the next source-build location.
    }
  }
  return undefined
}
