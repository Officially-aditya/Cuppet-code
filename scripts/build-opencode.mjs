#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const revision = '16747470f976aca3d362ad730bcd3fe82ecc2c9a'
const version = '1.18.29'
const sourceArgument = process.argv.find((argument) => argument.startsWith('--source='))
const outputArgument = process.argv.find((argument) => argument.startsWith('--output='))
if (!sourceArgument || !outputArgument) {
  throw new Error('usage: build-opencode.mjs --source=<checkout> --output=<binary>')
}
const source = resolve(sourceArgument.slice('--source='.length))
let output = resolve(outputArgument.slice('--output='.length))
if (process.platform === 'win32' && !output.toLowerCase().endsWith('.exe')) output += '.exe'
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const patchDirectory = resolve(repositoryRoot, 'patches', 'opencode')

const head = (await capture('git', ['rev-parse', 'HEAD'], source)).trim()
if (head !== revision) throw new Error(`OpenCode source mismatch: expected ${revision}, received ${head}`)
const metadata = JSON.parse(await readFile(resolve(source, 'packages/opencode/package.json'), 'utf8'))
if (metadata.version !== version) throw new Error(`OpenCode source version is ${metadata.version}, expected ${version}`)
const bunVersion = (await capture('bun', ['--version'], source)).trim()
if (bunVersion !== '1.3.14') throw new Error(`Bun 1.3.14 is required, received ${bunVersion}`)

const patchFiles = (await readdir(patchDirectory))
  .filter((name) => /^\d{4}-.*\.patch$/.test(name))
  .sort()
if (patchFiles.length === 0) throw new Error(`no OpenCode patches found in ${patchDirectory}`)
const patchSetDigest = createHash('sha256')
for (const name of patchFiles) {
  patchSetDigest.update(name)
  patchSetDigest.update(await readFile(join(patchDirectory, name)))
}
const digest = patchSetDigest.digest('hex')
const temporaryBase = await resolveTemporaryBase()
const temporaryRoot = await mkdtemp(join(temporaryBase, 'cuppet-opencode-'))
const patchedSource = join(temporaryRoot, 'source')

// Windows runners default to core.autocrlf=true, which would materialize CRLF
// into the worktree and make every LF-context hunk fail to apply.
await run('git', ['-c', 'core.autocrlf=false', 'worktree', 'add', '--detach', patchedSource, revision], source)
try {
  for (const patch of patchFiles) {
    const patchPath = join(patchDirectory, patch)
    await run('git', ['apply', '--check', '--whitespace=error', patchPath], patchedSource)
    await run('git', ['apply', '--whitespace=error', patchPath], patchedSource)
  }
  const identityPath = resolve(patchedSource, 'packages/opencode/src/cuppet/derivative/identity.ts')
  const identity = await readFile(identityPath, 'utf8')
  if (!identity.includes(revision) || !identity.includes('cuppet-opencode-derivative')) {
    throw new Error('OpenCode patch stack did not install the derivative identity marker')
  }

  const environment = {
    ...process.env,
    CI: '1',
    HUSKY: '0',
    OPENCODE_CHANNEL: 'latest',
    OPENCODE_VERSION: version,
    CUPPET_OPENCODE_PATCH_SET_DIGEST: digest,
    // Bun 1.3.14 on Windows mixes the 8.3 short form of the temp path with the
    // long form (oven-sh/bun#23960) and derives unusable workspace symlink
    // targets such as `..\..\..\runneradmin\AppData\Local\Temp\...`, failing
    // every workspace package with ENOENT. Pin every temp variable to the one
    // canonical directory so both forms agree.
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    TMPDIR: temporaryRoot,
  }
  await installDependencies(patchedSource, environment)
  const buildArguments = [
    'run',
    '--cwd',
    'packages/opencode',
    'script/build.ts',
    '--single',
    '--skip-install',
    '--skip-embed-web-ui',
  ]
  if (process.arch === 'x64') buildArguments.push('--baseline')
  try {
    await run('bun', buildArguments, patchedSource, environment)
  } catch (error) {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw error
    // Bun's Windows baseline executable download can be incomplete. Retry the
    // compile once after dependencies and patch verification have succeeded.
    process.stderr.write(`Windows OpenCode compile failed (${error.message}); retrying once\n`)
    await run('bun', buildArguments, patchedSource, environment)
  }

  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : process.platform === 'win32' ? 'win32' : undefined
  if (!platform || !['arm64', 'x64'].includes(process.arch)) {
    throw new Error(`unsupported OpenCode build host ${process.platform}-${process.arch}`)
  }
  const built = await findBuiltBinary(patchedSource)
  await mkdir(dirname(output), { recursive: true })
  const temporaryOutput = `${output}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await copyFile(built, temporaryOutput)
    await rename(temporaryOutput, output)
  } finally {
    await rm(temporaryOutput, { force: true }).catch(() => undefined)
  }
  if (process.platform !== 'win32') await chmod(output, 0o755)
  const markerPath = join(dirname(output), '.cuppet-derivative.json')
  await writeFile(markerPath, `${JSON.stringify({
    schema: 1,
    product: 'cuppet-opencode-derivative',
    upstreamRevision: revision,
    upstreamVersion: version,
    patchSetDigest: digest,
  }, null, 2)}\n`, { mode: 0o600 })
  const builtVersion = (await capture(output, ['--version'], patchedSource)).trim()
  if (builtVersion !== version) throw new Error(`built OpenCode version is ${builtVersion}, expected ${version}`)
  process.stdout.write(`${output}\n`)
} finally {
  await run('git', ['worktree', 'remove', '--force', patchedSource], source).catch(() => undefined)
  await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
}

// Bun 1.3.14 can reject an unmodified text lockfile in a large workspace
// monorepo (oven-sh/bun#29348): the frozen check compares in-memory hoisting
// state instead of the bytes it would write, so it reports drift that a plain
// install never makes. Prefer the strict install, and when it rejects the
// lockfile, prove instead that installing leaves `bun.lock` byte-identical.
// Real drift still fails: an install that changes dependencies rewrites the
// lockfile.
async function installDependencies(patchedSource, environment) {
  const lockfilePath = resolve(patchedSource, 'bun.lock')
  const committed = await readFile(lockfilePath).catch(() => undefined)
  try {
    await run('bun', ['install', '--frozen-lockfile'], patchedSource, environment)
    return
  } catch (error) {
    if (!committed) throw error
    process.stderr.write(
      `bun install --frozen-lockfile failed (${error.message}); re-verifying the lockfile by byte identity instead\n`,
    )
  }
  await run('bun', ['install'], patchedSource, environment)
  const installed = await readFile(lockfilePath).catch(() => undefined)
  if (!installed || !installed.equals(committed)) {
    throw new Error(`bun install rewrote ${lockfilePath}: the pinned revision's lockfile does not match its package.json files`)
  }
}

// Windows runners point `TEMP` at a deep per-user directory
// (`C:\Users\runneradmin\AppData\Local\Temp`) whose 62 character checkout path
// leaves the 4687-package install past the 260 character Win32 limit
// ("Filename too long"). `RUNNER_TEMP` is the short `D:\a\_temp`. Prefer the
// shortest writable base available, and let local Windows builds override it.
async function resolveTemporaryBase() {
  const candidates = [
    process.env.CUPPET_OPENCODE_TMP,
    process.env.RUNNER_TEMP,
    process.platform === 'win32' && process.env.SystemDrive
      ? join(process.env.SystemDrive, 'cuppet-tmp')
      : undefined,
    tmpdir(),
  // A Windows runner variable that leaks into a POSIX shell (`D:\a\_temp`) is
    // not absolute there, and `resolve` would turn it into a directory named
    // after the drive letter inside the checkout.
  ].filter((candidate) => candidate && isAbsolute(candidate))
  for (const candidate of candidates) {
    const base = resolve(candidate)
    try {
      await mkdir(base, { recursive: true })
      // realpath expands 8.3 names, so the child sees one spelling of the path.
      return await realpath(base)
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(`no writable temporary directory for the OpenCode build (tried ${candidates.join(', ')})`)
}

function findBuiltBinary(patchedSource) {
  const platform = process.platform === 'darwin'
    ? 'darwin'
    : process.platform === 'linux'
      ? 'linux'
      : process.platform === 'win32'
        ? 'win32'
        : undefined
  if (!platform || !['arm64', 'x64'].includes(process.arch)) {
    throw new Error(`unsupported OpenCode build host ${process.platform}-${process.arch}`)
  }
  const suffix = platform === 'win32' ? '.exe' : ''
  const baseline = process.arch === 'x64' ? '-baseline' : ''
  // Upstream names the dist directory with the Bun/target spelling, which is
  // `windows` on Windows (see the `opencode-windows-<arch>` optional
  // dependencies), not Node's `win32`.
  const distPlatform = platform === 'win32' ? 'windows' : platform
  const candidates = [
    // Preferred layout from `packages/opencode/script/build.ts --single`:
    // `dist/opencode-<platform>-<arch>[-baseline]/bin/opencode[.exe]`.
    resolve(patchedSource, 'packages/opencode/dist', `opencode-${distPlatform}-${process.arch}${baseline}`, `bin/opencode${suffix}`),
    resolve(patchedSource, 'packages/opencode/dist', `opencode-${distPlatform}-${process.arch}`, `bin/opencode${suffix}`),
    // Tolerate the `win32` spelling in case the upstream naming changes back.
    resolve(patchedSource, 'packages/opencode/dist', `opencode-${platform}-${process.arch}${baseline}`, `bin/opencode${suffix}`),
  ]
  return (async () => {
    for (const candidate of candidates) {
      try {
        await access(candidate)
        return candidate
      } catch {
        // Try the next candidate.
      }
    }
    let entries = []
    try {
      entries = await readdir(resolve(patchedSource, 'packages/opencode/dist'))
    } catch {
      entries = []
    }
    throw new Error(
      `built OpenCode binary not found (tried ${candidates.join(', ')}; dist contains: ${entries.join(', ') || 'nothing'})`,
    )
  })()
}

function run(command, arguments_, cwd, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { cwd, env, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0
      ? resolvePromise()
      : reject(new Error(`${command} exited ${code}`)))
  })
}

function capture(command, arguments_, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')))
    child.once('error', reject)
    child.once('exit', (code) => code === 0
      ? resolvePromise(stdout)
      : reject(new Error(`${command} exited ${code}: ${stderr.trim()}`)))
  })
}
