#!/usr/bin/env node
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const runtimeDirectories = {
  'darwin-arm64': 'runtime-darwin-arm64',
  'darwin-x64': 'runtime-darwin-x64',
  'linux-arm64': 'runtime-linux-arm64-gnu',
  'linux-x64': 'runtime-linux-x64-gnu',
}

const runtimeDirectory = runtimeDirectories[`${process.platform}-${process.arch}`]
if (!runtimeDirectory) throw new Error(`unsupported platform ${process.platform}-${process.arch}`)

const npm = process.env.npm_execpath
if (!npm) throw new Error('Run this installer with npm run install:global')

const runtime = resolve('artifacts', runtimeDirectory)
await access(resolve(runtime, 'manifest.json'))

const staging = await mkdtemp(join(tmpdir(), 'cuppet-install-'))
try {
  const runtimeTarball = await pack(runtime, staging)
  const cliTarball = await pack(resolve('packages', 'cli'), staging)
  await run(process.execPath, [npm, 'install', '--global', '--force', runtimeTarball, cliTarball])
  process.stdout.write('Installed cupet and cuppet as standalone global commands.\n')
} finally {
  await rm(staging, { recursive: true, force: true })
}

async function pack(source, destination) {
  const output = await capture(process.execPath, [npm, 'pack', source, '--pack-destination', destination])
  const filename = output.trim().split(/\r?\n/).at(-1)
  if (!filename) throw new Error(`npm pack produced no archive for ${source}`)
  return resolve(destination, filename)
}

function run(command, arguments_) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0
      ? resolvePromise()
      : reject(new Error(`${command} exited ${code}`)))
  })
}

function capture(command, arguments_) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { stdio: ['ignore', 'pipe', 'inherit'] })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk.toString('utf8')))
    child.once('error', reject)
    child.once('exit', (code) => code === 0
      ? resolvePromise(output)
      : reject(new Error(`${command} exited ${code}`)))
  })
}
