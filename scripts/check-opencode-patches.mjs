#!/usr/bin/env node
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const revision = '49c69c5ed3ccf706b61b3febb43c8aaff7f8325e'
const sourceArgument = process.argv.find((argument) => argument.startsWith('--source='))
if (!sourceArgument) throw new Error('usage: check-opencode-patches.mjs --source=<checkout>')

const source = resolve(sourceArgument.slice('--source='.length))
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const patchDirectory = resolve(repositoryRoot, 'patches', 'opencode')
const head = (await capture('git', ['rev-parse', 'HEAD'], source)).trim()
if (head !== revision) throw new Error(`OpenCode source mismatch: expected ${revision}, received ${head}`)

const patchFiles = (await readdir(patchDirectory))
  .filter((name) => /^\d{4}-.*\.patch$/.test(name))
  .sort()
if (patchFiles.length === 0) throw new Error(`no OpenCode patches found in ${patchDirectory}`)

const temporaryRoot = await mkdtemp(join(tmpdir(), 'cuppet-opencode-patch-check-'))
const patchedSource = join(temporaryRoot, 'source')
await run('git', ['worktree', 'add', '--detach', patchedSource, revision], source)
try {
  for (const patch of patchFiles) {
    const patchPath = join(patchDirectory, patch)
    await run('git', ['apply', '--check', '--whitespace=error', patchPath], patchedSource)
    await run('git', ['apply', '--whitespace=error', patchPath], patchedSource)
    process.stdout.write(`applied ${patch}\n`)
  }
} finally {
  await run('git', ['worktree', 'remove', '--force', patchedSource], source).catch(() => undefined)
  await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
}

function run(command, arguments_, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}`)))
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
    child.once('exit', (code) => code === 0 ? resolvePromise(stdout) : reject(new Error(`${command} exited ${code}: ${stderr.trim()}`)))
  })
}
