#!/usr/bin/env node
import { access, copyFile, mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputArgument = process.argv.find((argument) => argument.startsWith('--output='))
const output = resolve(root, outputArgument?.slice('--output='.length) ?? 'artifacts/npm')
const staging = await mkdtemp(join(tmpdir(), 'cuppet-cli-package-'))

try {
  await mkdir(output, { recursive: true })
  const rootPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const cliPackage = JSON.parse(await readFile(resolve(root, 'packages', 'cli', 'package.json'), 'utf8'))
  if (cliPackage.name !== 'cuppet') throw new Error(`unexpected CLI package name: ${cliPackage.name}`)
  if (cliPackage.version !== rootPackage.version) {
    throw new Error(`CLI version ${cliPackage.version} does not match root version ${rootPackage.version}`)
  }

  await run('npm', [
    'pack',
    '--workspace=cuppet',
    '--pack-destination',
    staging,
    '--ignore-scripts=false',
  ], root)

  const tarballs = (await readdir(staging)).filter((name) => name.endsWith('.tgz'))
  if (tarballs.length !== 1) throw new Error(`expected one CLI tarball, found ${tarballs.length}`)
  const tarball = resolve(staging, tarballs[0])
  const listing = await capture('tar', ['-tzf', tarball], root)
  const entries = new Set(listing.split(/\r?\n/).filter(Boolean))
  for (const required of [
    'package/package.json',
    'package/dist/cli.js',
    'package/relay-app/index.html',
    'package/relay-app/app.js',
    'package/relay-app/styles.css',
  ]) {
    if (!entries.has(required)) throw new Error(`CLI tarball is missing ${required}`)
  }
  if ([...entries].some((entry) => entry.endsWith('.env') || entry.includes('/.env.'))) {
    throw new Error('CLI tarball contains an environment file')
  }

  const outputTarball = resolve(output, basename(tarball))
  await copyFile(tarball, outputTarball)

  // Prove that a clean CI machine can install and invoke the thin package even
  // before platform-specific optional runtimes are selected.
  const installRoot = resolve(staging, 'install')
  await run('npm', [
    'install',
    '--prefix',
    installRoot,
    '--omit=optional',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    tarball,
  ], root)
  const installedCli = resolve(installRoot, 'node_modules', 'cuppet', 'dist', 'cli.js')
  await access(installedCli)
  await run(process.execPath, [installedCli, '--version'], root)

  const digest = createHash('sha256').update(await readFile(outputTarball)).digest('hex')
  process.stdout.write(`created ${outputTarball}\nsha256 ${digest}\n`)
} finally {
  await rm(staging, { recursive: true, force: true })
}

function run(command, arguments_, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, { cwd, stdio: 'inherit' })
    child.once('error', rejectPromise)
    child.once('exit', (code) => code === 0
      ? resolvePromise()
      : rejectPromise(new Error(`${command} exited with code ${code}`)))
  })
}

function capture(command, arguments_, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')))
    child.once('error', rejectPromise)
    child.once('exit', (code) => code === 0
      ? resolvePromise(stdout)
      : rejectPromise(new Error(`${command} exited with code ${code}: ${stderr.trim()}`)))
  })
}
