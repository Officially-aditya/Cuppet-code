#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { basename, join, resolve } from 'node:path'

const targetArgument = process.argv.find((argument) => argument.startsWith('--target='))
if (!targetArgument) throw new Error('--target=<rust-target> is required')
const target = targetArgument.slice('--target='.length)
const targets = {
  'aarch64-apple-darwin': ['runtime-darwin-arm64', 'darwin', 'arm64', null],
  'x86_64-apple-darwin': ['runtime-darwin-x64', 'darwin', 'x64', null],
  'aarch64-unknown-linux-gnu': ['runtime-linux-arm64-gnu', 'linux', 'arm64', 'glibc'],
  'x86_64-unknown-linux-gnu': ['runtime-linux-x64-gnu', 'linux', 'x64', 'glibc'],
}
const configuration = targets[target]
if (!configuration) throw new Error(`unsupported release target ${target}`)
const [packageDirectory, platform, arch, libc] = configuration
const opencodeSource = process.env.CUPPET_OPENCODE_BIN
if (!opencodeSource) throw new Error('CUPPET_OPENCODE_BIN must point to the audited 1.18.4 binary')

const output = resolve('artifacts', packageDirectory)
await mkdir(join(output, 'bin'), { recursive: true })
await mkdir(join(output, 'plugin'), { recursive: true })
const files = {
  'bin/opencode': resolve(opencodeSource),
  'bin/tst-daemon': resolve('target', target, 'release', 'tst-daemon'),
  'plugin/index.js': resolve('packages/opencode-plugin/dist/index.js'),
}
for (const [destination, source] of Object.entries(files)) await copyFile(source, join(output, destination))
await chmod(join(output, 'bin/opencode'), 0o755)
await chmod(join(output, 'bin/tst-daemon'), 0o755)
await chmod(join(output, 'plugin/index.js'), 0o644)

if (platform === 'darwin') {
  const identity = process.env.CUPPET_APPLE_SIGN_IDENTITY
  if (!identity && process.env.CI && process.env.CUPPET_ALLOW_UNSIGNED !== '1') {
    throw new Error('CUPPET_APPLE_SIGN_IDENTITY is required for macOS release artifacts')
  }
  if (identity) {
    await run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, join(output, 'bin/opencode')])
    await run('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, join(output, 'bin/tst-daemon')])
  }
}

const checksums = {}
for (const relative of Object.keys(files)) checksums[relative] = await sha256(join(output, relative))
const sourceManifest = JSON.parse(await readFile(resolve('packages', packageDirectory, 'manifest.json'), 'utf8'))
const manifest = { ...sourceManifest, platform, arch, libc, files: checksums }
await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

const sourcePackage = JSON.parse(await readFile(resolve('packages', packageDirectory, 'package.json'), 'utf8'))
await writeFile(join(output, 'package.json'), `${JSON.stringify(sourcePackage, null, 2)}\n`)
for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) await copyFile(resolve(name), join(output, name))
const cargoMetadata = JSON.parse(await capture('cargo', [
  'metadata',
  '--format-version=1',
  '--locked',
  '--filter-platform',
  target,
]))
const softwarePackages = [
  spdxPackage('Cuppet', '0.2.0-alpha.1', 'Apache-2.0', 'SPDXRef-Cuppet'),
  spdxPackage('OpenCode', '1.18.4', 'MIT', 'SPDXRef-OpenCode'),
  spdxPackage('zod', '3.25.76', 'MIT', 'SPDXRef-Zod'),
  ...cargoMetadata.packages.map((item, index) => spdxPackage(
    item.name,
    item.version,
    item.license ?? 'NOASSERTION',
    `SPDXRef-Cargo-${index}-${safeID(item.name)}`,
  )),
]
await writeFile(
  join(output, 'sbom.spdx.json'),
  `${JSON.stringify({
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `cuppet-${target}`,
    documentNamespace: `https://cuppet.dev/sbom/${target}/0.2.0-alpha.1`,
    creationInfo: {
      created: new Date().toISOString(),
      creators: ['Tool: Cuppet release packager-0.2.0-alpha.1'],
    },
    packages: softwarePackages,
    relationships: softwarePackages.map((item) => ({
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: item.SPDXID,
    })),
  }, null, 2)}\n`,
)
process.stdout.write(`${output}\n`)

async function sha256(path) {
  const hash = createHash('sha256')
  const data = await readFile(path)
  hash.update(data)
  return hash.digest('hex')
}

function run(command, arguments_) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)))
  })
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

function spdxPackage(name, version, license, id) {
  return {
    SPDXID: id,
    name,
    versionInfo: version,
    downloadLocation: 'NOASSERTION',
    filesAnalyzed: false,
    licenseConcluded: license,
    licenseDeclared: license,
    copyrightText: 'NOASSERTION',
  }
}

function safeID(value) {
  return value.replace(/[^A-Za-z0-9.-]/g, '-')
}
