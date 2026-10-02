#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
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
const opencodeRevision = '16747470f976aca3d362ad730bcd3fe82ecc2c9a'

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
  `  3. cargo build -p tst-daemon --release --locked --target=${platformTarget}`,
  '  4. git clone --filter=blob:none --no-checkout https://github.com/anomalyco/opencode.git .opencode-src (if missing)',
  `  5. git -C .opencode-src checkout --detach ${opencodeRevision}`,
  '  6. npm exec --yes --package=bun@1.3.14 -- node scripts/build-opencode.mjs --source=.opencode-src --output=.opencode/opencode',
  `  7. CUPPET_OPENCODE_BIN=<repo>/.opencode/opencode node scripts/package-platform.mjs --target=${platformTarget}`,
  'Then re-run npm run install:global from the repository root.',
].join('\n')

const npmLauncher = await resolveNpmLauncher()
const localRuntime = repoPath('artifacts', runtimeDirectory)
const cliSource = repoPath('packages', 'cli')
const pluginDist = repoPath('packages', 'opencode-plugin', 'dist')
const patchDirectory = repoPath('patches', 'opencode')

const staging = await mkdtemp(join(tmpdir(), 'cuppet-install-'))
const npmEnvironment = {
  ...process.env,
  // Keep installation self-contained. A stale root-owned ~/.npm cache must not
  // prevent a user-local global install from working.
  NPM_CONFIG_CACHE: join(staging, 'npm-cache'),
  npm_config_cache: join(staging, 'npm-cache'),
}

// Fresh clones have no gitignored `artifacts/` output. Prefer a local build
// when present, otherwise fall back to the published `@cuppet-code/*` runtime
// for this version. Unpublished checkouts build the native runtime locally.
try {
  let runtime = localRuntime
  try {
    await access(resolve(localRuntime, 'manifest.json'))
    await validateRuntime(localRuntime)
    await refreshRuntimePlugins(localRuntime, pluginDist)
    await validateRuntime(localRuntime)
  } catch (localError) {
    const fallback = await tryRegistryRuntime()
    if (fallback) {
      runtime = fallback
      process.stdout.write(`Using published runtime for ${platformKey} (local artifacts missing).\n`)
    } else {
      process.stdout.write(`No compatible local or published runtime for ${platformKey}; building from source.\n`)
      try {
        await buildLocalRuntime()
        await validateRuntime(localRuntime)
      } catch (error) {
        throw new Error(`Unable to build runtime for ${platformKey}: ${error.message ?? error}\nSource builds require Git and Rust.\n${buildRemedy}`, { cause: localError })
      }
    }
  }

  try {
    await access(resolve(cliSource, 'dist', 'cli.js'))
  } catch {
    throw new Error(
      `CLI build is missing at ${resolve(cliSource, 'dist', 'cli.js')}; run npm ci && npm run build, then re-run npm run install:global`,
    )
  }
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

async function buildLocalRuntime() {
  try {
    await access(repoPath('node_modules', 'typescript', 'package.json'))
  } catch {
    await run(npmLauncher.command, [...npmLauncher.prefix, 'ci'], npmEnvironment, npmLauncher.shell)
  }
  await run(npmLauncher.command, [...npmLauncher.prefix, 'run', 'build'], npmEnvironment, npmLauncher.shell)
  await run('cargo', ['build', '-p', 'tst-daemon', '--release', '--locked', `--target=${platformTarget}`], npmEnvironment)

  let opencodeBinary = process.env.CUPPET_OPENCODE_BIN
  if (!opencodeBinary) {
    const source = repoPath('.opencode-src')
    try {
      await access(source)
    } catch {
      await run('git', ['clone', '--filter=blob:none', '--no-checkout', 'https://github.com/anomalyco/opencode.git', source], npmEnvironment)
      await run('git', ['-C', source, 'checkout', '--detach', opencodeRevision], npmEnvironment)
    }
    opencodeBinary = repoPath('.opencode', process.platform === 'win32' ? 'opencode.exe' : 'opencode')
    await run(npmLauncher.command, [
      ...npmLauncher.prefix, 'exec', '--yes', '--package=bun@1.3.14', '--',
      process.execPath, repoPath('scripts', 'build-opencode.mjs'), `--source=${source}`, `--output=${opencodeBinary}`,
    ], npmEnvironment, npmLauncher.shell)
  }
  await run(process.execPath, [repoPath('scripts', 'package-platform.mjs'), `--target=${platformTarget}`], {
    ...npmEnvironment,
    CUPPET_OPENCODE_BIN: resolve(opencodeBinary),
  })
}

async function tryRegistryRuntime() {
  let version
  try {
    version = JSON.parse(await readFile(repoPath('package.json'), 'utf8')).version
  } catch {
    return undefined
  }
  const spec = `@cuppet-code/${runtimeDirectory}@${version}`
  const downloadDir = join(staging, 'registry-runtime-download')
  const extractDir = join(staging, 'registry-runtime')
  try {
    await mkdir(downloadDir, { recursive: true })
    await mkdir(extractDir, { recursive: true })
    let output
    try {
      output = await capture(
        npmLauncher.command,
        [...npmLauncher.prefix, 'pack', spec, '--pack-destination', downloadDir],
        npmEnvironment,
        npmLauncher.shell,
      )
    } catch (error) {
      process.stderr.write(`Registry fallback unavailable for ${spec}: ${error.message ?? error}\n`)
      return undefined
    }
    const filename = output.trim().split(/\r?\n/).at(-1)?.trim()
    if (!filename || !filename.endsWith('.tgz')) return undefined
    const tarball = resolve(downloadDir, filename)
    try {
      await access(tarball)
    } catch {
      return undefined
    }
    // `tar` ships with macOS, Linux, and Windows 10+; package-cli.mjs relies on it too.
    try {
      await run('tar', ['-xzf', tarball, '-C', extractDir, '--strip-components=1'], npmEnvironment, process.platform === 'win32')
    } catch (error) {
      process.stderr.write(`Unable to unpack registry runtime ${spec}: ${error.message ?? error}\n`)
      return undefined
    }
    // Best-effort: overlay locally built plugins so `npm run build` changes ship
    // even when the binary runtime comes from the registry. Keep the published
    // plugin when no local build exists (fresh clone).
    try {
      await access(resolve(pluginDist, 'index.js'))
      await refreshRuntimePlugins(extractDir, pluginDist)
    } catch {
      // Keep registry-bundled plugin; validation below still applies.
    }
    try {
      await validateRuntime(extractDir)
    } catch (error) {
      // Local patches differ from the published artifact: require a rebuild
      // rather than silently installing a stale runtime.
      process.stderr.write(`Registry runtime failed validation: ${error.message ?? error}\n`)
      return undefined
    }
    return extractDir
  } catch (error) {
    process.stderr.write(`Registry fallback failed: ${error.message ?? error}\n`)
    return undefined
  }
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
      child = spawn(command, arguments_, { cwd: repositoryRoot, stdio: 'inherit', env: environment, shell })
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
