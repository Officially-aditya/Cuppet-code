#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

if (!process.env.NODE_AUTH_TOKEN) throw new Error('NODE_AUTH_TOKEN is required')

const root = resolve(process.argv[2] ?? 'artifacts')
const manifests = await find(root, 'manifest.json')
if (manifests.length !== 4) throw new Error(`expected four platform packages, found ${manifests.length}`)

const releaseVersion = JSON.parse(await readFile(resolve('package.json'), 'utf8')).version
const prereleaseTag = releaseVersion.match(/^[0-9]+\.[0-9]+\.[0-9]+-([0-9A-Za-z-]+)/)?.[1]
const publishFlags = [
  '--provenance',
  '--access',
  'public',
  ...(prereleaseTag ? ['--tag', prereleaseTag] : []),
]

for (const directory of manifests.map(dirname).sort()) {
  await publishIfMissing(directory, publishFlags)
}
await publishIfMissing(resolve('packages/cli'), publishFlags, ['--workspace=cuppet'])

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
    const child = spawn(command, arguments_, { stdio: 'inherit' })
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
  await run('npm', ['publish', ...publishArguments, ...flags])
}

function isPublished(name, version) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('npm', ['view', `${name}@${version}`, 'version', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] })
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
