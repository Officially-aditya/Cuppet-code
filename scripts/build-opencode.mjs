#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const revision = '49c69c5ed3ccf706b61b3febb43c8aaff7f8325e'
const version = '1.18.4'
const sourceArgument = process.argv.find((argument) => argument.startsWith('--source='))
const outputArgument = process.argv.find((argument) => argument.startsWith('--output='))
if (!sourceArgument || !outputArgument) {
  throw new Error('usage: build-opencode.mjs --source=<checkout> --output=<binary>')
}
const source = resolve(sourceArgument.slice('--source='.length))
const output = resolve(outputArgument.slice('--output='.length))
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
const temporaryRoot = await mkdtemp(join(tmpdir(), 'cuppet-opencode-'))
const patchedSource = join(temporaryRoot, 'source')

await run('git', ['worktree', 'add', '--detach', patchedSource, revision], source)
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
  }
  await run('bun', ['install', '--frozen-lockfile'], patchedSource, environment)
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
  await run('bun', buildArguments, patchedSource, environment)

  const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : undefined
  if (!platform || !['arm64', 'x64'].includes(process.arch)) {
    throw new Error(`unsupported OpenCode build host ${process.platform}-${process.arch}`)
  }
  const packageName = `opencode-${platform}-${process.arch}${process.arch === 'x64' ? '-baseline' : ''}`
  const built = resolve(patchedSource, 'packages/opencode/dist', packageName, 'bin/opencode')
  await mkdir(dirname(output), { recursive: true })
  await copyFile(built, output)
  await chmod(output, 0o755)
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
