import { readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const testDir = join(repoRoot, 'packages', 'cli', 'test')
const entries = await readdir(testDir, { withFileTypes: true })
const tests = entries
  .filter((entry) => entry.isFile() && /^pe3-.*\.test\.ts$/.test(entry.name))
  .map((entry) => relative(repoRoot, join(testDir, entry.name)))
  .sort()

if (tests.length === 0) {
  throw new Error('No packages/cli/test/pe3-*.test.ts files were discovered')
}

console.log(`Running all ${tests.length} discovered PE3 regression tests:`)
for (const test of tests) console.log(`  ${test}`)

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...tests],
  { cwd: repoRoot, env: process.env, stdio: 'inherit' },
)

if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
