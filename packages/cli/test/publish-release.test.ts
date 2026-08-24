import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const publisher = join(repository, 'scripts/publish-release.mjs')

test('release publisher skips packages already published at the exact version', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'cuppet-publish-release-'))
  try {
    const version = '0.2.0-alpha.1'
    await writeFile(join(fixture, 'package.json'), JSON.stringify({ version }))
    await mkdir(join(fixture, 'packages/cli'), { recursive: true })
    await writeFile(join(fixture, 'packages/cli/package.json'), JSON.stringify({ name: 'cuppet', version }))

    for (const [index, name] of [
      '@cuppet-code/runtime-darwin-arm64',
      '@cuppet-code/runtime-darwin-x64',
      '@cuppet-code/runtime-linux-arm64-gnu',
      '@cuppet-code/runtime-linux-x64-gnu',
    ].entries()) {
      const directory = join(fixture, `artifacts/runtime-${index}`)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'manifest.json'), '{}')
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version }))
    }

    const bin = join(fixture, 'bin')
    await mkdir(bin)
    const fakeNpm = join(bin, 'npm')
    await writeFile(fakeNpm, `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args[0] !== 'view') {
  console.error('unexpected npm command: ' + args.join(' '))
  process.exit(2)
}
process.stdout.write(JSON.stringify(args[1].split('@').at(-1)))
`)
    await chmod(fakeNpm, 0o755)

    const result = await runPublisher(fixture, bin)
    assert.equal(result.code, 0, result.stderr)
    assert.equal((result.stdout.match(/already published/g) ?? []).length, 5)
    assert.doesNotMatch(result.stderr, /unexpected npm command/)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})

function runPublisher(cwd: string, bin: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [publisher, join(cwd, 'artifacts')], {
      cwd,
      env: { ...process.env, NODE_AUTH_TOKEN: 'test-token', PATH: `${bin}:${process.env.PATH ?? ''}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk) => (stderr += chunk.toString('utf8')))
    child.once('error', reject)
    child.once('exit', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }))
  })
}
