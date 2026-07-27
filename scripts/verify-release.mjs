#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? 'artifacts')
const expectedArgument = process.argv.find((argument) => argument.startsWith('--expected='))
const expectedCount = Number(expectedArgument?.slice('--expected='.length) ?? 4)
if (!Number.isInteger(expectedCount) || expectedCount < 1) throw new Error('--expected must be a positive integer')
const releaseVersion = JSON.parse(await readFile(resolve('package.json'), 'utf8')).version
const manifests = await find(root, 'manifest.json')
if (manifests.length !== expectedCount) {
  throw new Error(`expected ${expectedCount} platform manifests, found ${manifests.length}`)
}
const platformKeys = new Set()
for (const manifestPath of manifests) {
  const directory = manifestPath.slice(0, -'/manifest.json'.length)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (
    manifest.opencodeVersion !== '1.18.4' ||
    manifest.sdkVersion !== '1.18.4' ||
    manifest.opencodeRevision !== '49c69c5ed3ccf706b61b3febb43c8aaff7f8325e'
  ) {
    throw new Error(`version mismatch in ${manifestPath}`)
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.patchSetDigest ?? '')) throw new Error(`invalid derivative patch digest in ${manifestPath}`)
  if (manifest.tstProtocol !== 'cuppet.tst.v1') throw new Error(`protocol mismatch in ${manifestPath}`)
  const platformKey = `${manifest.platform}-${manifest.arch}-${manifest.libc ?? 'native'}`
  if (platformKeys.has(platformKey)) throw new Error(`duplicate platform package ${platformKey}`)
  platformKeys.add(platformKey)
  const packageMetadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  if (packageMetadata.version !== releaseVersion || !packageMetadata.name?.startsWith('@cuppet/runtime-')) {
    throw new Error(`invalid package metadata in ${directory}`)
  }
  for (const [relative, expected] of Object.entries(manifest.files)) {
    const path = join(directory, relative)
    const actual = createHash('sha256').update(await readFile(path)).digest('hex')
    if (actual !== expected) throw new Error(`checksum mismatch for ${path}`)
    if (relative.startsWith('bin/') && ((await stat(path)).mode & 0o111) === 0) {
      throw new Error(`binary is not executable: ${path}`)
    }
  }
  const marker = JSON.parse(await readFile(join(directory, 'bin/.cuppet-derivative.json'), 'utf8'))
  if (
    marker.product !== 'cuppet-opencode-derivative' ||
    marker.upstreamVersion !== '1.18.4' ||
    marker.upstreamRevision !== '49c69c5ed3ccf706b61b3febb43c8aaff7f8325e' ||
    marker.patchSetDigest !== manifest.patchSetDigest
  ) throw new Error(`invalid derivative identity marker in ${directory}`)
  for (const required of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'sbom.spdx.json']) {
    if (!(await stat(join(directory, required))).isFile()) throw new Error(`missing ${required} in ${directory}`)
  }
  const sbom = JSON.parse(await readFile(join(directory, 'sbom.spdx.json'), 'utf8'))
  if (
    sbom.spdxVersion !== 'SPDX-2.3' ||
    !Array.isArray(sbom.packages) ||
    !sbom.packages.some((item) => item.name === 'OpenCode' && item.versionInfo === '1.18.4') ||
    !sbom.packages.some((item) => item.name === 'tst-daemon') ||
    !sbom.packages.some((item) => item.name === 'Cuppet OpenCode derivative patch set')
  ) {
    throw new Error(`incomplete SPDX SBOM in ${directory}`)
  }
}
process.stdout.write(`verified ${manifests.length} platform package(s)\n`)

async function find(directory, name) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await find(path, name))
    else if (entry.name === name) output.push(path)
  }
  return output
}
