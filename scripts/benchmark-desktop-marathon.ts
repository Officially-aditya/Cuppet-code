import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const project = resolve(process.cwd())
const canonicalManifestPath = resolve(project, 'benchmarks/manifests/issue-4.json')
const forwarded = process.argv.slice(2)

for (const reserved of ['--manifest', '--arms', '--session-topology']) {
  if (forwarded.includes(reserved)) {
    throw new Error(`${reserved} is fixed by benchmark:cuppet:marathon so the canonical 12-task Desktop Cuppet workload cannot be changed`)
  }
}

const manifest = JSON.parse(await readFile(canonicalManifestPath, 'utf8'))
if (manifest?.taskSet?.tasks?.length !== 12) {
  throw new Error(`Expected the canonical Issue #4 marathon to contain 12 tasks; found ${manifest?.taskSet?.tasks?.length ?? 'unknown'}`)
}

const cuppet = manifest.arms?.find((arm: { id?: string }) => arm.id === 'cuppet')
if (!cuppet) throw new Error('Canonical Issue #4 manifest does not contain a Cuppet arm')

const armScript = '{controllerRoot}/scripts/benchmark-arm.ts'
const desktopArmScript = '{controllerRoot}/scripts/benchmark-desktop-arm.ts'
const commandArgs = Array.isArray(cuppet.command?.args) ? cuppet.command.args : []
if (!commandArgs.includes(armScript)) {
  throw new Error('Canonical Cuppet arm command changed; refusing to patch an unknown harness shape')
}

cuppet.harnessVersion = 'Cuppet Desktop independent RuntimeService; runtime version captured by arm result'
cuppet.model.notes = 'Cuppet Desktop receives the manifest model/effort through its native provider layer; PE3 routing and managed TST remain enabled so marathon token consumption reflects the new runtime architecture.'
cuppet.command.args = commandArgs.map((value: string) => value === armScript ? desktopArmScript : value)

const temporaryRoot = await mkdtemp(join(tmpdir(), 'cuppet-desktop-marathon-'))
const temporaryManifest = join(temporaryRoot, 'issue-4-desktop-cuppet.json')
await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

const args = [
  '--import', 'tsx',
  resolve(project, 'scripts/benchmark-runner.ts'),
  '--manifest', temporaryManifest,
  '--session-topology', 'marathon',
  '--arms', 'cuppet',
  ...forwarded,
]

try {
  const child = spawn(process.execPath, args, {
    cwd: project,
    env: process.env,
    stdio: 'inherit',
  })
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (signal) return resolveExit(1)
      resolveExit(code ?? 1)
    })
  })
  process.exitCode = exitCode
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
