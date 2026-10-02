import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const runtimeDirectories = {
  'darwin-arm64': ['runtime-darwin-arm64', 'aarch64-apple-darwin'],
  'darwin-x64': ['runtime-darwin-x64', 'x86_64-apple-darwin'],
  'linux-arm64': ['runtime-linux-arm64-gnu', 'aarch64-unknown-linux-gnu'],
  'linux-x64': ['runtime-linux-x64-gnu', 'x86_64-unknown-linux-gnu'],
}
const configuration = runtimeDirectories[`${process.platform}-${process.arch}`]
const options = { skip: !configuration }
const version = '0.2.0-alpha.5'

test('global installer builds an incomplete runtime when its exact release is unpublished', options, async () => {
  await withFixture(async ({ root, runtime, install, commands }) => {
    await writeRuntime(root, runtime)
    await rm(join(runtime, 'bin/opencode'))

    const result = await install()
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /building from source/)
    assert.match(result.stdout, /Installed cupet and cuppet/)
    const calls = await commands()
    assert.deepEqual(calls.map(({ tool, args }) => [tool, args[0]]), [
      ['npm', 'pack'], ['npm', 'ci'], ['npm', 'run'], ['cargo', 'build'],
      ['git', 'clone'], ['git', '-C'], ['npm', 'exec'],
      ['npm', 'pack'], ['npm', 'pack'], ['npm', 'install'],
    ])
    assert.ok(calls.filter((call) => call.args[0] !== 'pack').every((call) => call.cwd === root))
    assert.deepEqual(calls.find((call) => call.tool === 'cargo').args, [
      'build', '-p', 'tst-daemon', '--release', '--locked', `--target=${configuration[1]}`,
    ])
    assert.ok(calls.find((call) => call.args[0] === 'exec').args.includes('--package=bun@1.3.14'))
    assert.equal(JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8')).version, version)
  })
})

test('global installer keeps using a valid local runtime without fetching or rebuilding', options, async () => {
  await withFixture(async ({ root, runtime, install, commands }) => {
    await writeRuntime(root, runtime)
    const result = await install()
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual((await commands()).map(({ tool, args }) => [tool, args[0]]), [
      ['npm', 'pack'], ['npm', 'pack'], ['npm', 'install'],
    ])
  })
})

test('global installer uses a compatible published runtime without building', options, async () => {
  await withFixture(async ({ root, install, commands }) => {
    const published = join(root, 'published/package')
    await writeRuntime(root, published)
    const archive = join(root, 'published.tgz')
    const packed = await execute('tar', ['-czf', archive, '-C', dirname(published), 'package'])
    assert.equal(packed.code, 0, packed.stderr)
    const result = await install({ CUPPET_TEST_REGISTRY: archive })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /Using published runtime/)
    assert.deepEqual((await commands()).map(({ tool, args }) => [tool, args[0]]), [
      ['npm', 'pack'], ['npm', 'pack'], ['npm', 'pack'], ['npm', 'install'],
    ])
  })
})

test('global installer validates a rebuilt runtime before installing it', options, async () => {
  await withFixture(async ({ install, commands }) => {
    const result = await install({ CUPPET_TEST_INCOMPLETE: '1' })
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /runtime artifact is incomplete: missing bin\/opencode/)
    assert.ok(!(await commands()).some((call) => call.args[0] === 'install'))
  })
})

test('global installer reuses an explicitly supplied derivative and existing dependencies', options, async () => {
  await withFixture(async ({ root, install, commands }) => {
    const binary = join(root, 'custom-opencode')
    await writeFile(binary, 'built derivative')
    await mkdir(join(root, 'node_modules/typescript'), { recursive: true })
    await writeFile(join(root, 'node_modules/typescript/package.json'), '{}')
    const result = await install({ CUPPET_OPENCODE_BIN: binary })
    assert.equal(result.code, 0, result.stderr)
    const calls = await commands()
    assert.ok(!calls.some((call) => call.tool === 'git' || ['ci', 'exec'].includes(call.args[0])))
    assert.ok(calls.some((call) => call.tool === 'cargo'))
  })
})

async function withFixture(check) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cuppet-global-install-test-')))
  try {
    const runtime = join(root, 'artifacts', configuration[0])
    const log = join(root, 'commands.ndjson')
    for (const directory of ['scripts/lib', 'patches/opencode', 'packages/cli/dist', 'packages/opencode-plugin/dist', 'test-bin']) {
      await mkdir(join(root, directory), { recursive: true })
    }
    await copyFile(join(repository, 'scripts/install-global.mjs'), join(root, 'scripts/install-global.mjs'))
    await copyFile(join(repository, 'scripts/lib/runtime-plugin-sync.mjs'), join(root, 'scripts/lib/runtime-plugin-sync.mjs'))
    await writeFile(join(root, 'package.json'), JSON.stringify({ version, type: 'module' }))
    await writeFile(join(root, 'patches/opencode/0001-fixture.patch'), 'fixture patch')
    await writeFile(join(root, 'packages/cli/package.json'), JSON.stringify({ name: 'cuppet', version }))
    await writeFile(join(root, 'packages/cli/dist/cli.js'), 'CLI build')
    for (const name of ['index.js', 'server.js', 'tui.js']) {
      await writeFile(join(root, 'packages/opencode-plugin/dist', name), `current ${name}`)
    }
    const fakeNpm = join(root, 'test-bin/npm.mjs')
    await writeFile(fakeNpm, `import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
appendFileSync(process.env.CUPPET_TEST_LOG, JSON.stringify({ tool: 'npm', args, cwd: process.cwd() }) + '\\n')
if (args[0] === 'pack') {
  const destination = args[args.indexOf('--pack-destination') + 1]
  const archive = join(destination, 'fixture-' + (args[1].includes('runtime') ? 'runtime' : 'cli') + '.tgz')
  if (args[1].startsWith('@cuppet-code/')) {
    if (!process.env.CUPPET_TEST_REGISTRY) { console.error('ETARGET: release is unpublished'); process.exit(1) }
    copyFileSync(process.env.CUPPET_TEST_REGISTRY, archive)
  } else { writeFileSync(archive, 'packed') }
  console.log(archive.split(/[\\\\/]/).at(-1))
} else if (args[0] === 'exec') {
  const command = args.indexOf('--') + 1
  const result = spawnSync(args[command], args.slice(command + 1), { stdio: 'inherit' })
  process.exit(result.status ?? 1)
} else if (args[0] === 'ci') {
  mkdirSync('node_modules/typescript', { recursive: true })
  writeFileSync('node_modules/typescript/package.json', '{}')
} else if (!['run', 'install'].includes(args[0])) { process.exit(2) }
`)
    const fakeTool = `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs'
import { basename } from 'node:path'
const tool = basename(process.argv[1])
const args = process.argv.slice(2)
appendFileSync(process.env.CUPPET_TEST_LOG, JSON.stringify({ tool, args, cwd: process.cwd() }) + '\\n')
if (tool === 'git' && args[0] === 'clone') mkdirSync(args.at(-1))
`
    for (const tool of ['git', 'cargo']) {
      await writeFile(join(root, 'test-bin', tool), fakeTool)
      await chmod(join(root, 'test-bin', tool), 0o755)
    }
    await writeFile(join(root, 'scripts/build-opencode.mjs'), `import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
const output = process.argv.find((arg) => arg.startsWith('--output=')).slice('--output='.length)
await mkdir(dirname(output), { recursive: true })
await writeFile(output, 'built derivative')
`)
    await writeFile(join(root, 'scripts/package-platform.mjs'), `import { createHash } from 'node:crypto'
import { access, chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
await access(process.env.CUPPET_OPENCODE_BIN)
await (${writeRuntime.toString()})(process.cwd(), ${JSON.stringify(runtime)})
if (process.env.CUPPET_TEST_INCOMPLETE) await rm(${JSON.stringify(join(runtime, 'bin/opencode'))})
`)
    await check({
      root,
      runtime,
      install: (environment = {}) => execute(process.execPath, [join(root, 'scripts/install-global.mjs')], {
        ...process.env,
        CUPPET_OPENCODE_BIN: '',
        npm_execpath: fakeNpm,
        PATH: `${join(root, 'test-bin')}:${process.env.PATH}`,
        CUPPET_TEST_LOG: log,
        ...environment,
      }),
      commands: async () => (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)),
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function writeRuntime(root, runtime) {
  await mkdir(join(runtime, 'bin'), { recursive: true })
  await mkdir(join(runtime, 'plugin'), { recursive: true })
  const patchSetDigest = createHash('sha256').update('0001-fixture.patch').update('fixture patch').digest('hex')
  await writeFile(join(runtime, 'bin/opencode'), 'built derivative')
  await writeFile(join(runtime, 'bin/.cuppet-derivative.json'), JSON.stringify({ product: 'cuppet-opencode-derivative', patchSetDigest }))
  await writeFile(join(runtime, 'bin/tst-daemon'), '#!/bin/sh\nprintf "cuppet.tst.v3\\n"\n')
  await chmod(join(runtime, 'bin/tst-daemon'), 0o755)
  const files = {}
  for (const name of ['index.js', 'server.js', 'tui.js']) {
    await copyFile(join(root, 'packages/opencode-plugin/dist', name), join(runtime, 'plugin', name))
  }
  for (const name of ['bin/opencode', 'bin/.cuppet-derivative.json', 'bin/tst-daemon', 'plugin/index.js', 'plugin/server.js', 'plugin/tui.js']) {
    files[name] = createHash('sha256').update(await readFile(join(runtime, name))).digest('hex')
  }
  await writeFile(join(runtime, 'manifest.json'), JSON.stringify({ patchSetDigest, files, tstProtocol: 'cuppet.tst.v3' }))
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ name: '@cuppet-code/' + runtime.split(/[\\/]/).at(-1), version: '0.2.0-alpha.5' }))
}

function execute(command, args, env = process.env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => resolvePromise({ code, stdout, stderr }))
  })
}
