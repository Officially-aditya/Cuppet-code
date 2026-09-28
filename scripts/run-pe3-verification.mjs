#!/usr/bin/env node
// Local equivalent of the removed pe3 workflow: the same gates, runnable on
// macOS, Linux, and Windows, with the expensive derivative build opt-out so a
// routing-only change can be verified in under a minute.
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { pe3VerificationSteps, requiresOpenCodeSource } from './lib/pe3-verification.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(flag('--source=') ?? join(repositoryRoot, '.opencode-src'))
const only = flags('--only=')
const skip = flags('--skip=')

const temporaryRoot = await mkdtemp(join(tmpdir(), 'cuppet-pe3-'))
const patchedSource = join(temporaryRoot, 'cuppet-opencode-patched')
const environment = {
  ...process.env,
  // Strict offline routing: a missing model asset must fall back to the active
  // task instead of reaching for the network.
  CUPPET_PE3_ALLOW_MODEL_DOWNLOAD: process.env.CUPPET_PE3_ALLOW_MODEL_DOWNLOAD ?? '0',
}

const steps = pe3VerificationSteps(source, patchedSource)
const selected = steps.filter((step) => {
  if (only.length > 0 && !only.some((value) => step.name.includes(value))) return false
  if (skip.some((value) => step.name.includes(value))) return false
  return true
})

if (process.argv.includes('--list')) {
  for (const step of steps) process.stdout.write(`${selected.includes(step) ? 'run ' : 'skip '} ${step.name}\n`)
  process.exit(0)
}

if (selected.length === 0) throw new Error('no PE3 verification steps selected')
if (selected.some(requiresOpenCodeSource) && !(await exists(source))) {
  throw new Error(
    `OpenCode source checkout not found at ${source}\n` +
      'clone the pinned derivative base first:\n' +
      `  git clone https://github.com/anomalyco/opencode ${source}\n` +
      `or drop the steps that need it: --skip=verify-opencode-patch-stack --skip=build-opencode-derivative`,
  )
}

try {
  for (const [index, step] of selected.entries()) {
    process.stdout.write(`\n=== [${index + 1}/${selected.length}] ${step.name} ===\n`)
    await run(step.name, step.command, step.arguments)
    // The PE3 contract tests read this to decide whether the patched derivative
    // is importable. Exporting it before the patch step has produced it would
    // turn a skipped suite into a hard failure, so only publish it once the
    // stack is materialized.
    if (step.name === 'verify-opencode-patch-stack') environment.CUPPET_PE3_PATCHED_SOURCE = patchedSource
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined)
}

function flags(prefix) {
  return process.argv
    .filter((value) => value.startsWith(prefix))
    .map((value) => value.slice(prefix.length))
}

function flag(prefix) {
  return flags(prefix)[0]
}

function run(name, command, arguments_) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, arguments_, { cwd: repositoryRoot, env: environment, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0
      ? resolvePromise()
      : reject(new Error(`${name}: \`${command} ${arguments_.join(' ')}\` exited ${code}`)))
  })
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
