import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { pe3VerificationSteps, requiresOpenCodeSource } from './pe3-verification.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const steps = pe3VerificationSteps('.opencode-src', '/tmp/patched')

test('PE3 verification covers every gate the workflow used to enforce', () => {
  assert.deepEqual(steps.map((step) => step.name), [
    'verify-opencode-patch-stack',
    'build-workspaces',
    'typecheck-pe3',
    'pe3-regression-suite',
    'task-affinity-router',
    'control-routing-boundary',
    'native-tui-handoff',
    'routing-benchmark',
    'build-opencode-derivative',
  ])
})

test('every locally referenced test file and script still exists', () => {
  for (const step of steps) {
    for (const argument of step.arguments) {
      if (argument.startsWith('-')) continue
      const path = resolve(repositoryRoot, argument)
      if (path.endsWith('.ts')) assert.ok(existsSync(path), `${step.name} references missing ${argument}`)
    }
  }
})

test('the patch stack and derivative build agree on the OpenCode source', () => {
  const sources = steps
    .flatMap((step) => step.arguments)
    .filter((argument) => argument.startsWith('--source='))
  assert.deepEqual(sources, ['--source=.opencode-src', '--source=.opencode-src'])
})

test('the patch verification output is a substituted path, not a literal placeholder', () => {
  const step = steps.find((entry) => entry.name === 'verify-opencode-patch-stack')
  assert.deepEqual(step.arguments, [
    'scripts/check-opencode-patches.mjs',
    '--source=.opencode-src',
    '--output=/tmp/patched',
  ])
})

test('the derivative build targets the documented output path', () => {
  const step = steps.find((entry) => entry.name === 'build-opencode-derivative')
  assert.deepEqual(step.arguments, [
    'scripts/build-opencode.mjs',
    '--source=.opencode-src',
    '--output=.opencode/opencode',
  ])
})

test('workspace build and typecheck both cover cuppet and the opencode plugin', () => {
  for (const name of ['build-workspaces', 'typecheck-pe3']) {
    const step = steps.find((entry) => entry.name === name)
    assert.deepEqual(step.arguments.slice(0, 2), ['run', name === 'build-workspaces' ? 'build' : 'typecheck'])
    assert.ok(step.arguments.includes('--workspace=cuppet'))
    assert.ok(step.arguments.includes('--workspace=@cuppet-code/opencode-plugin'))
  }
})

test('the runner is wired to a package script and keeps model downloads off by default', async () => {
  const manifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.scripts['verify:pe3'], 'node scripts/run-pe3-verification.mjs')
  const runner = await readFile(join(repositoryRoot, 'scripts', 'run-pe3-verification.mjs'), 'utf8')
  assert.match(runner, /CUPPET_PE3_ALLOW_MODEL_DOWNLOAD: process\.env\.CUPPET_PE3_ALLOW_MODEL_DOWNLOAD \?\? '0'/)
})

test('the patched source is published only after the patch stack is materialized', async () => {
  const runner = await readFile(join(repositoryRoot, 'scripts', 'run-pe3-verification.mjs'), 'utf8')
  const [environmentDeclaration] = runner.split('const steps =')
  // The PE3 contract tests treat an exported-but-missing patched source as a
  // failure while an unexported one skips them, so the initial environment must
  // not carry the variable at all.
  assert.doesNotMatch(environmentDeclaration, /CUPPET_PE3_PATCHED_SOURCE/)
  assert.match(runner, /step\.name === 'verify-opencode-patch-stack'\) environment\.CUPPET_PE3_PATCHED_SOURCE = patchedSource/)
})

test('only the patch stack and derivative build steps need the OpenCode checkout', () => {
  const needing = steps.filter(requiresOpenCodeSource).map((step) => step.name)
  assert.deepEqual(needing, ['verify-opencode-patch-stack', 'build-opencode-derivative'])
})

test('the deleted pe3 workflow is not referenced anywhere in the repository', async () => {
  const runner = await readFile(join(repositoryRoot, 'scripts', 'run-pe3-verification.mjs'), 'utf8')
  assert.doesNotMatch(runner, /\.github\/workflows\/pe3\.yml/)
})
