#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? 'artifacts')
const manifests = await find(root, 'manifest.json')
const registryArgument = process.argv.find((argument) => argument.startsWith('--registry='))
const expectedArgument = process.argv.find((argument) => argument.startsWith('--expected='))
const runtimesOnly = process.argv.includes('--runtimes-only')
const registry = registryArgument?.slice('--registry='.length) ?? 'https://registry.npmjs.org'
const expectedCount = Number(expectedArgument?.slice('--expected='.length) ?? (runtimesOnly ? 1 : 6))
if (!process.env.NODE_AUTH_TOKEN) throw new Error('NODE_AUTH_TOKEN is required')
if (!Number.isInteger(expectedCount) || expectedCount < 1) throw new Error('--expected must be a positive integer')
if (manifests.length !== expectedCount) throw new Error(`expected ${expectedCount} platform packages, found ${manifests.length}`)

const releaseVersion = JSON.parse(await readFile(resolve('package.json'), 'utf8')).version
const prereleaseTag = releaseVersion.match(/^[0-9]+\.[0-9]+\.[0-9]+-([0-9A-Za-z-]+)/)?.[1]
const publishFlags = [
  ...(registry === 'https://registry.npmjs.org' ? ['--provenance', '--access', 'public'] : []),
  ...(prereleaseTag ? ['--tag', prereleaseTag] : []),
  '--registry',
  registry,
]

// Refuse to publish `cuppet` unless every runtime it pins resolves from the
// registry immediately afterwards. npm treats a missing optionalDependency as a
// silent success, so a partial publish installs a CLI that dies on first run
// with no install-time signal. A half-published version cannot be repaired by
// retrying, because npm will not overwrite it; it has to be superseded instead.
async function preflightPins(artifactDirectories) {
  if (runtimesOnly) return
  const cliMetadata = JSON.parse(await readFile(resolve('packages/cli/package.json'), 'utf8'))
  const pins = Object.entries(cliMetadata.optionalDependencies ?? {})
  if (pins.length === 0) return
  if (cliMetadata.version !== releaseVersion) {
    throw new Error(`packages/cli is version ${cliMetadata.version} but the release is ${releaseVersion}`)
  }
  const available = new Set()
  for (const directory of artifactDirectories) {
    const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    if (metadata.version !== releaseVersion) {
      throw new Error(`${metadata.name} is version ${metadata.version} but the release is ${releaseVersion}; rebuild every platform artifact from the same tag`)
    }
    available.add(metadata.name)
  }
  const missing = []
  for (const [name, version] of pins) {
    if (version !== releaseVersion) missing.push(`${name}@${version} (release pins ${releaseVersion})`)
    else if (!available.has(name)) missing.push(`${name}@${version}`)
  }
  if (missing.length === 0) return
  const already = []
  for (const [name, version] of pins) {
    if (await isPublished(name, version)) already.push(`${name}@${version}`)
  }
  if (already.length > 0 && already.length < pins.length) {
    throw new Error([
      `refusing to publish a partially released ${releaseVersion}`,
      `already on ${registry}: ${already.join(', ')}`,
      `still missing: ${missing.join(', ')}`,
      'npm will not overwrite a published version, so retrying cannot repair this; bump the version instead.',
    ].join('\n'))
  }
  throw new Error([
    `refusing to publish ${cliMetadata.name}@${releaseVersion}: ${pins.length} pinned runtime(s) are unavailable`,
    `unresolvable pins: ${missing.join(', ')}`,
    `built ${artifactDirectories.length} runtime artifact(s) under ${root}`,
    'Build every platform artifact in a single run, or pass the matching --expected=<count>.',
  ].join('\n'))
}

const artifactDirectories = manifests.map(dirname).sort()
await preflightPins(artifactDirectories)

for (const directory of artifactDirectories) {
  await publishIfMissing(directory, publishFlags)
}
if (!runtimesOnly) await publishIfMissing(resolve('packages/cli'), publishFlags, ['--workspace=cuppet'])

async function find(directory, name) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await find(path, name))
    else if (entry.name === name) output.push(path)
  }
  return output
}

function run(command, arguments_) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, npmSpawnOptions({ stdio: 'inherit' }))
    child.once('error', reject)
    child.once('exit', (code) => code === 0
      ? resolvePromise()
      : reject(new Error(`${command} exited ${code}`)))
  })
}

async function publishIfMissing(directory, flags, extraArguments = []) {
  const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  if (await isPublished(metadata.name, metadata.version)) {
    process.stdout.write(`already published ${metadata.name}@${metadata.version}; skipping\n`)
    return
  }
  const publishArguments = extraArguments.length > 0 ? extraArguments : [directory]
  await run(npmCommand(), ['publish', ...publishArguments, ...flags])
}

function npmCommand() {
  // Kept as a single command name: `run`/`isPublished` route npm through
  // the shell on Windows, where `npm` is a batch file (`npm.cmd`) that
  // CreateProcess cannot execute directly.
  return 'npm'
}

function npmSpawnOptions(base) {
  return { ...base, shell: process.platform === 'win32' }
}

function isPublished(name, version) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(npmCommand(), ['view', `${name}@${version}`, 'version', '--json', '--registry', registry], npmSpawnOptions({ stdio: ['ignore', 'pipe', 'pipe'] }))
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')))
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) {
        try {
          resolvePromise(JSON.parse(stdout.trim()) === version)
        } catch (error) {
          reject(error)
        }
        return
      }
      if (/E404|404 Not Found/i.test(`${stdout}\n${stderr}`)) {
        resolvePromise(false)
        return
      }
      reject(new Error(`npm view failed for ${name}@${version}: ${stderr.trim() || stdout.trim()}`))
    })
  })
}
