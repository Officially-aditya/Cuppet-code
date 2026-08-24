#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const artifacts = resolve(process.argv[2] ?? 'artifacts')
const output = resolve(process.argv[3] ?? 'release-assets')
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })

const manifests = await findFiles(artifacts, 'manifest.json')
if (manifests.length !== 4) throw new Error(`expected four platform manifests, found ${manifests.length}`)

for (const manifestPath of manifests) {
  const directory = dirname(manifestPath)
  const name = `cuppet-${basename(directory)}.tar.gz`
  await run('tar', ['-czf', join(output, name), '-C', directory, '.'])
}

const cliTarballs = (await findFiles(artifacts, undefined)).filter((path) => path.endsWith('.tgz'))
if (cliTarballs.length !== 1) throw new Error(`expected one CLI npm tarball, found ${cliTarballs.length}`)
await copyFile(cliTarballs[0], join(output, basename(cliTarballs[0])))

const files = (await readdir(output)).sort()
const checksums = []
for (const file of files) {
  const digest = createHash('sha256').update(await readFile(join(output, file))).digest('hex')
  checksums.push(`${digest}  ${file}`)
}
await writeFile(join(output, 'SHA256SUMS'), `${checksums.join('\n')}\n`)
process.stdout.write(`created ${files.length} release assets in ${output}\n`)

async function findFiles(directory, name) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) result.push(...await findFiles(path, name))
    else if (!name || entry.name === name) result.push(path)
  }
  return result
}

function run(command, arguments_) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, arguments_, { stdio: 'inherit' })
    child.once('error', rejectPromise)
    child.once('exit', (code) => code === 0
      ? resolvePromise()
      : rejectPromise(new Error(`${command} exited with code ${code}`)))
  })
}
