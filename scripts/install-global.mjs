#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const runtimeDirectories = {
  'darwin-arm64': 'runtime-darwin-arm64',
  'darwin-x64': 'runtime-darwin-x64',
  'linux-arm64': 'runtime-linux-arm64-gnu',
  'linux-x64': 'runtime-linux-x64-gnu',
}
const expectedTstProtocol = 'cuppet.tst.v2'

const runtimeDirectory = runtimeDirectories[`${process.platform}-${process.arch}`]
if (!runtimeDirectory) throw new Error(`unsupported platform ${process.platform}-${process.arch}`)

const npm = process.env.npm_execpath
if (!npm) throw new Error('Run this installer with npm run install:global')

const runtime = resolve('artifacts', runtimeDirectory)
await access(resolve(runtime, 'manifest.json'))
await validateRuntime(runtime)

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
  const cliTarball = await pack(resolve('packages', 'cli'), staging, npmEnvironment)
  await run(process.execPath, [npm, 'install', '--global', '--force', runtimeTarball, cliTarball], npmEnvironment)
  process.stdout.write('Installed cupet and cuppet as standalone global commands.\n')
} finally {
  await rm(staging, { recursive: true, force: true })
}

async function pack(source, destination, environment) {
  const output = await capture(process.execPath, [npm, 'pack', source, '--pack-destination', destination], environment)
  const filename = output.trim().split(/\r?\n/).at(-1)
  if (!filename) throw new Error(`npm pack produced no archive for ${source}`)
  return resolve(destination, filename)
}

async function validateRuntime(root) {
  let manifest
  try {
    manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'))
  } catch {
    throw new Error(`runtime artifact is unreadable at ${root}; build and package the pinned OpenCode derivative first`)
  }
  const expectedFiles = [
    'bin/opencode',
    'bin/.cuppet-derivative.json',
    'bin/tst-daemon',
    'plugin/index.js',
    'plugin/server.js',
    'plugin/tui.js',
  ]
  const hasDigest = typeof manifest.patchSetDigest === 'string' && /^[a-f0-9]{64}$/.test(manifest.patchSetDigest)
  const hasFiles = expectedFiles.every((file) => typeof manifest.files?.[file] === 'string')
  if (!hasDigest || !hasFiles) {
    throw new Error(
      `runtime artifact is stale at ${root}; run build:opencode and package:platform before install:global`,
    )
  }
  if (manifest.tstProtocol !== expectedTstProtocol) {
    throw new Error(
      `runtime artifact TST protocol is ${manifest.tstProtocol ?? 'missing'}; expected ${expectedTstProtocol}. Rebuild the runtime before installing`,
    )
  }
  for (const file of expectedFiles) {
    const path = resolve(root, file)
    await access(path)
    const actual = createHash('sha256').update(await readFile(path)).digest('hex')
    if (actual !== manifest.files[file]) throw new Error(`runtime artifact checksum mismatch for ${file}`)
  }
  const marker = JSON.parse(await readFile(resolve(root, 'bin/.cuppet-derivative.json'), 'utf8'))
  if (marker.product !== 'cuppet-opencode-derivative' || marker.patchSetDigest !== manifest.patchSetDigest) {
    throw new Error(`runtime derivative marker is incompatible at ${root}`)
  }
  const patchHash = createHash('sha256')
  for (const name of (await readdir(resolve('patches', 'opencode')))
    .filter((item) => /^\d{4}-.*\.patch$/.test(item))
    .sort()) {
    patchHash.update(name)
    patchHash.update(await readFile(resolve('patches', 'opencode', name)))
  }
  if (patchHash.digest('hex') !== manifest.patchSetDigest) {
    throw new Error('runtime artifact patch set does not match this checkout; rebuild it before installing')
  }
  const daemonProtocol = (await capture(resolve(root, 'bin/tst-daemon'), ['--protocol'], process.env)).trim()
  if (daemonProtocol !== expectedTstProtocol) {
    throw new Error(
      `runtime TST daemon protocol mismatch: expected ${expectedTstProtocol}, received ${daemonProtocol || 'no identity'}`,
    )
  }
}

function run(command, arguments_, environment) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { stdio: 'inherit', env: environment })
    child.once('error', reject)
    child.once('exit', (code) => code === 0
      ? resolvePromise()
      : reject(new Error(`${command} exited ${code}`)))
  })
}

function capture(command, arguments_, environment) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'inherit'], env: environment })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk.toString('utf8')))
    child.once('error', reject)
    child.once('exit', (code) => code === 0
      ? resolvePromise(output)
      : reject(new Error(`${command} exited ${code}`)))
  })
}
