#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const EXPECTED_PROTOCOL = 'cuppet.tst.v3'
const TARGETS = {
  'aarch64-apple-darwin': { platform: 'darwin', arch: 'arm64', libc: null },
  'x86_64-apple-darwin': { platform: 'darwin', arch: 'x64', libc: null },
  'aarch64-unknown-linux-gnu': { platform: 'linux', arch: 'arm64', libc: 'glibc' },
  'x86_64-unknown-linux-gnu': { platform: 'linux', arch: 'x64', libc: 'glibc' },
}

const sourceArgument = argument('source') ?? process.env.CUPPET_TST_BIN
if (!sourceArgument) throw new Error('TST binary is required via --source=<path> or CUPPET_TST_BIN')
const target = argument('target')
const configuration = target ? TARGETS[target] : inferCurrentPlatform()
if (!configuration) throw new Error(`unsupported TST runtime target: ${target ?? `${process.platform}-${process.arch}`}`)

const source = resolve(sourceArgument)
const version = JSON.parse(await readFile(resolve('package.json'), 'utf8')).version
const runtime = runtimeKey(configuration)
const output = resolve(argument('output') ?? join('artifacts', `tst-runtime-${runtime}`))
const metadataPath = join(output, 'tst-runtime.json')
const binaryPath = join(output, 'bin', process.platform === 'win32' ? 'tst-daemon.exe' : 'tst-daemon')

const sourceStats = await stat(source).catch(() => null)
if (!sourceStats?.isFile()) throw new Error(`TST binary is missing: ${source}`)
if (process.platform !== 'win32' && (sourceStats.mode & 0o111) === 0) throw new Error(`TST binary is not executable: ${source}`)

const protocol = (await capture(source, ['--protocol'])).trim()
if (protocol !== EXPECTED_PROTOCOL) {
  throw new Error(`TST protocol mismatch: expected ${EXPECTED_PROTOCOL}, received ${protocol || 'no identity'}`)
}

await rm(output, { recursive: true, force: true })
await mkdir(join(output, 'bin'), { recursive: true })
await copyFile(source, binaryPath)
if (process.platform !== 'win32') await chmod(binaryPath, 0o755)

for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) {
  await copyFile(resolve(name), join(output, name))
}

const digest = await sha256(binaryPath)
const metadata = {
  schema: 1,
  kind: 'cuppet-tst-runtime',
  version,
  protocol: EXPECTED_PROTOCOL,
  runtime,
  platform: configuration.platform,
  arch: configuration.arch,
  libc: configuration.libc,
  target: target ?? null,
  sourceRepository: 'Officially-aditya/Cuppet-code',
  sourceRevision: process.env.GITHUB_SHA ?? null,
  files: {
    [`bin/${basename(binaryPath)}`]: digest,
  },
}
await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o644 })
process.stdout.write(`${output}\n`)

function argument(name) {
  const prefix = `--${name}=`
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length)
}

function inferCurrentPlatform() {
  if (process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch)) {
    return { platform: 'darwin', arch: process.arch, libc: null }
  }
  if (process.platform === 'linux' && ['arm64', 'x64'].includes(process.arch)) {
    return { platform: 'linux', arch: process.arch, libc: 'glibc' }
  }
  return null
}

function runtimeKey({ platform, arch, libc }) {
  return `${platform}-${arch}${libc === 'glibc' ? '-gnu' : ''}`
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

function capture(command, arguments_) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'pipe'] })
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
