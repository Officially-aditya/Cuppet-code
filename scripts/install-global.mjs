#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { access, chmod, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { refreshRuntimePlugins } from './lib/runtime-plugin-sync.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoPath = (...segments) => resolve(repositoryRoot, ...segments)

const runtimeDirectories = {
  'darwin-arm64': 'runtime-darwin-arm64',
  'darwin-x64': 'runtime-darwin-x64',
  'linux-arm64': 'runtime-linux-arm64-gnu',
  'linux-x64': 'runtime-linux-x64-gnu',
  'win32-x64': 'runtime-win32-x64',
  'win32-arm64': 'runtime-win32-arm64',
}
const platformBuildTargets = {
  'runtime-darwin-arm64': 'aarch64-apple-darwin',
  'runtime-darwin-x64': 'x86_64-apple-darwin',
  'runtime-linux-arm64-gnu': 'aarch64-unknown-linux-gnu',
  'runtime-linux-x64-gnu': 'x86_64-unknown-linux-gnu',
  'runtime-win32-x64': 'x86_64-pc-windows-msvc',
  'runtime-win32-arm64': 'aarch64-pc-windows-msvc',
}
const expectedTstProtocol = 'cuppet.tst.v3'

const platformKey = `${process.platform}-${process.arch}`
const runtimeDirectory = runtimeDirectories[platformKey]
if (!runtimeDirectory) {
  throw new Error(
    `unsupported platform ${platformKey}; supported: ${Object.keys(runtimeDirectories).sort().join(', ')}`,
  )
}
const platformTarget = platformBuildTargets[runtimeDirectory] ?? '<rust-target>'
const buildRemedy = [
  `missing or incomplete runtime for ${platformKey} (${runtimeDirectory}).`,
  'Build it first:',
  '  1. npm ci',
  '  2. npm run build',
  '  3. cargo build -p tst-daemon',
  '  4. node scripts/build-opencode.mjs --source=.opencode-src --output=.opencode/opencode',
  `  5. CUPPET_OPENCODE_BIN=<repo>/.opencode/opencode node scripts/package-platform.mjs --target=${platformTarget}`,
  'Then re-run npm run install:global from the repository root.',
].join('\n')

const npmLauncher = await resolveNpmLauncher()
const runtime = repoPath('artifacts', runtimeDirectory)
const cliSource = repoPath('packages', 'cli')
const pluginDist = repoPath('packages', 'opencode-plugin', 'dist')
const patchDirectory = repoPath('patches', 'opencode')

try {
  await access(resolve(runtime, 'manifest.json'))
} catch {
  throw new Error(`runtime artifact is missing at ${runtime};\n${buildRemedy}`)
}

await validateRuntime(runtime)
await refreshRuntimePlugins(runtime, pluginDist)
await validateRuntime(runtime)

try {
  await access(resolve(cliSource, 'dist', 'cli.js'))
} catch {
  throw new Error(
    `CLI build is missing at ${resolve(cliSource, 'dist', 'cli.js')}; run npm ci && npm run build, then re-run npm run install:global`,
  )
}

const staging = await mkdtemp(join(tmpdir(), 'cuppet-install-'))
const npmEnvironment = {
  ...process.env,
  // Keep installation self-contained. A stale root-owned ~/.npm cache must not
  // prevent a user-local global install from working.
  NPM_CONFIG_CACHE: join(staging, 'npm-cache'),
  npm_config_cache: join(staging, 'npm-cache'),
}
try {
  const runtimeTarball = await pack(runtime, staging, npmEnvironment)
  const cliTarball = await pack(cliSource, staging, npmEnvironment)
  await run(npmLauncher.command, [...npmLauncher.prefix, 'install', '--global', '--force', runtimeTarball, cliTarball], npmEnvironment, npmLauncher.shell)
  process.stdout.write('Installed cupet and cuppet as standalone global commands.\n')
} finally {
  // maxRetries/retryDelay matter on Windows where AV/indexers briefly lock new files.
  await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined)
}

async function resolveNpmLauncher() {
  const execpath = process.env.npm_execpath
  if (execpath) {
    try {
      await access(execpath)
      return { command: process.execPath, prefix: [execpath], shell: false }
    } catch {
      // Fall through to PATH lookup; stale npm_execpath values produce ENOENT otherwise.
    }
  }
  if (process.env.npm_config_user_agent) {
    // Running under npm/yarn/pnpm but npm_execpath was not propagated; prefer a
    // PATH lookup over failing outright.
  }
  // `npm` is npm.cmd (a batch file) on Windows and requires a shell; node +
  // npm-cli.js does not. Prefer the direct file when available, otherwise use
  // the shell-aware fallback so `node scripts/install-global.mjs` also works.
  return { command: 'npm', prefix: [], shell: process.platform === 'win32' }
}

async function pack(source, destination, environment) {
  let output
  try {
    output = await capture(
      npmLauncher.command,
      [...npmLauncher.prefix, 'pack', source, '--pack-destination', destination],
      environment,
      npmLauncher.shell,
    )
  } catch (error) {
    throw new Error(`npm pack failed for ${source}: ${error.message ?? error}`)
  }
  const filename = output.trim().split(/\r?\n/).at(-1)?.trim()
  if (!filename || !filename.endsWith('.tgz')) {
    throw new Error(`npm pack produced no archive for ${source}; output was: ${JSON.stringify(output.trim())}`)
  }
  const tarball = resolve(destination, filename)
  try {
    await access(tarball)
  } catch {
    throw new Error(`npm pack reported ${filename} for ${source} but the file is missing at ${tarball}`)
  }
  return tarball
}

async function validateRuntime(root) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'))
  } catch {
    throw new Error(`runtime artifact is unreadable at ${root};\n${buildRemedy}`)
  }
  const executableSuffix = process.platform === 'win32' ? '.exe' : ''
  const expectedFiles = [
    `bin/opencode${executableSuffix}`,
    'bin/.cuppet-derivative.json',
    `bin/tst-daemon${executableSuffix}`,
    'plugin/index.js',
    'plugin/server.js',
    'plugin/tui.js',
  ]
  const hasDigest = typeof manifest.patchSetDigest === 'string' && /^[a-f0-9]{64}$/.test(manifest.patchSetDigest)
  const hasFiles = expectedFiles.every((file) => typeof manifest.files?.[file] === 'string')
  if (!hasDigest || !hasFiles) {
    throw new Error(
      `runtime artifact is stale at ${root}; run build:opencode and package:platform before install:global\n${buildRemedy}`,
    )
  }
  if (manifest.tstProtocol !== expectedTstProtocol) {
    throw new Error(
      `runtime artifact TST protocol is ${manifest.tstProtocol ?? 'missing'}; expected ${expectedTstProtocol}. Rebuild the runtime before installing`,
    )
  }
  for (const file of expectedFiles) {
    const path = resolve(root, file)
    try {
      await access(path)
    } catch {
      throw new Error(`runtime artifact is incomplete: missing ${file} at ${path};\n${buildRemedy}`)
    }
    let data
    try {
      data = await readFile(path)
    } catch (error) {
      throw new Error(`runtime artifact is unreadable: ${file} at ${path}: ${error.code ?? error.message ?? error};\n${buildRemedy}`)
    }
    const actual = createHash('sha256').update(data).digest('hex')
    if (actual !== manifest.files[file]) throw new Error(`runtime artifact checksum mismatch for ${file}`)
  }
  // POSIX checkouts (git, zip, artifact round-trips) can lose the exec bit.
  // Repair best-effort before spawning the daemon so macOS/Linux don't report
  // a cryptic EACCES/ENOENT from spawn.
  if (process.platform !== 'win32') {
    for (const file of [`bin/opencode${executableSuffix}`, `bin/tst-daemon${executableSuffix}`]) {
      try {
        await chmod(resolve(root, file), 0o755)
      } catch {
        // validate via spawn below; a real failure surfaces with context there.
      }
    }
  }
  let marker
  try {
    marker = JSON.parse(await readFile(resolve(root, 'bin/.cuppet-derivative.json'), 'utf8'))
  } catch {
    throw new Error(`runtime derivative marker is unreadable at ${root};\n${buildRemedy}`)
  }
  if (marker.product !== 'cuppet-opencode-derivative' || marker.patchSetDigest !== manifest.patchSetDigest) {
    throw new Error(`runtime derivative marker is incompatible at ${root}`)
  }
  let patchNames
  try {
    patchNames = (await readdir(patchDirectory))
      .filter((item) => /^\d{4}-.*\.patch$/.test(item))
      .sort()
  } catch (error) {
    throw new Error(`unable to read patches at ${patchDirectory}: ${error.code ?? error.message ?? error}`)
  }
  const patchHash = createHash('sha256')
  for (const name of patchNames) {
    patchHash.update(name)
    patchHash.update(await readFile(resolve(patchDirectory, name)))
  }
  if (patchHash.digest('hex') !== manifest.patchSetDigest) {
    throw new Error('runtime artifact patch set does not match this checkout; rebuild it before installing')
  }
  const daemonPath = resolve(root, `bin/tst-daemon${executableSuffix}`)
  let daemonProtocol
  try {
    daemonProtocol = (await capture(daemonPath, ['--protocol'], process.env, false)).trim()
  } catch (error) {
    const code = error?.code ?? error?.errno
    const hint = code === 'ENOENT'
      ? `tst-daemon is missing or not executable at ${daemonPath}`
      : code === 'EACCES'
        ? `tst-daemon is not executable at ${daemonPath} (try chmod +x)`
        : `unable to run tst-daemon at ${daemonPath}`
    throw new Error(`${hint}: ${error.message ?? error};\n${buildRemedy}`)
  }
  if (daemonProtocol !== expectedTstProtocol) {
    throw new Error(
      `runtime TST daemon protocol mismatch: expected ${expectedTstProtocol}, received ${daemonProtocol || 'no identity'}`,
    )
  }
}

function run(command, arguments_, environment, shell = false) {
  const display = `${command} ${arguments_.join(' ')}`
  return new Promise((resolvePromise, reject) => {
    let child
    try {
      child = spawn(command, arguments_, { stdio: 'inherit', env: environment, shell })
    } catch (error) {
      reject(new Error(`failed to spawn ${display}: ${error.message ?? error}`))
      return
    }
    child.once('error', (error) => {
      const code = error?.code ?? error?.message ?? error
      reject(new Error(`failed to spawn ${display}: ${code}`))
    })
    child.once('exit', (code, signal) => code === 0
      ? resolvePromise()
      : reject(new Error(`${display} exited ${exitReason(code, signal)}`)))
  })
}

function capture(command, arguments_, environment, shell = false) {
  const display = `${command} ${arguments_.join(' ')}`
  return new Promise((resolvePromise, reject) => {
    let child
    try {
      child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'inherit'], env: environment, shell })
    } catch (error) {
      reject(new Error(`failed to spawn ${display}: ${error.message ?? error}`))
      return
    }
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk.toString('utf8')))
    child.once('error', (error) => {
      const code = error?.code ?? error?.message ?? error
      reject(new Error(`failed to spawn ${display}: ${code}`))
    })
    child.once('exit', (code, signal) => code === 0
      ? resolvePromise(output)
      : reject(new Error(`${display} exited ${exitReason(code, signal)}`)))
  })
}

function exitReason(code, signal) {
  return signal ?? (code === null ? 'unknown' : code)
}

