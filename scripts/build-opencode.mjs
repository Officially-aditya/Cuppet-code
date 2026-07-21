#!/usr/bin/env node
import { copyFile, chmod, mkdir, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'

const revision = '0317531906d3f3bb01cf33c16319870cfde9170c'
const version = '1.18.4'
const sourceArgument = process.argv.find((argument) => argument.startsWith('--source='))
const outputArgument = process.argv.find((argument) => argument.startsWith('--output='))
if (!sourceArgument || !outputArgument) {
  throw new Error('usage: build-opencode.mjs --source=<checkout> --output=<binary>')
}
const source = resolve(sourceArgument.slice('--source='.length))
const output = resolve(outputArgument.slice('--output='.length))

const head = (await capture('git', ['rev-parse', 'HEAD'], source)).trim()
if (head !== revision) throw new Error(`OpenCode source mismatch: expected ${revision}, received ${head}`)
const metadata = JSON.parse(await readFile(resolve(source, 'packages/opencode/package.json'), 'utf8'))
if (metadata.version !== version) throw new Error(`OpenCode source version is ${metadata.version}, expected ${version}`)
const bunVersion = (await capture('bun', ['--version'], source)).trim()
if (bunVersion !== '1.3.14') throw new Error(`Bun 1.3.14 is required, received ${bunVersion}`)

const environment = {
  ...process.env,
  CI: '1',
  HUSKY: '0',
  OPENCODE_CHANNEL: 'latest',
  OPENCODE_VERSION: version,
}
await run('bun', ['install', '--frozen-lockfile'], source, environment)
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
await run('bun', buildArguments, source, environment)

const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : undefined
if (!platform || !['arm64', 'x64'].includes(process.arch)) {
  throw new Error(`unsupported OpenCode build host ${process.platform}-${process.arch}`)
}
const packageName = `opencode-${platform}-${process.arch}${process.arch === 'x64' ? '-baseline' : ''}`
const built = resolve(source, 'packages/opencode/dist', packageName, 'bin/opencode')
await mkdir(dirname(output), { recursive: true })
await copyFile(built, output)
await chmod(output, 0o755)
const builtVersion = (await capture(output, ['--version'], source)).trim()
if (builtVersion !== version) throw new Error(`built OpenCode version is ${builtVersion}, expected ${version}`)
process.stdout.write(`${output}\n`)

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
