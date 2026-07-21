#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

if (!process.env.NODE_AUTH_TOKEN) throw new Error('NODE_AUTH_TOKEN is required')

const root = resolve(process.argv[2] ?? 'artifacts')
const manifests = await find(root, 'manifest.json')
if (manifests.length !== 4) throw new Error(`expected four platform packages, found ${manifests.length}`)

for (const directory of manifests.map(dirname).sort()) {
  await run('npm', ['publish', directory, '--provenance', '--access', 'public'])
}
await run('npm', ['publish', '--workspace=cuppet', '--provenance', '--access', 'public'])

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
