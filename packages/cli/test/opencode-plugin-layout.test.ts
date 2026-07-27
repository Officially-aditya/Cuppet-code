import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { installOpenCodePlugin } from '../src/opencode/server.js'

test('server and TUI plugin entrypoints are installed into separate discovery roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cuppet-opencode-plugin-layout-'))
  const serverSource = join(root, 'server.js')
  const tuiSource = join(root, 'tui.js')
  await writeFile(serverSource, 'export default { server() {} }\n')
  await writeFile(tuiSource, 'export default { tui() {} }\n')
  try {
    await installOpenCodePlugin(serverSource, root, tuiSource)
    const configRoot = join(root, 'opencode')
    assert.equal(await readFile(join(configRoot, 'plugins', 'cuppet.js'), 'utf8'), 'export default { server() {} }\n')
    assert.equal(await readFile(join(configRoot, 'tui-plugins', 'cuppet-tui.js'), 'utf8'), 'export default { tui() {} }\n')
    await assert.rejects(readFile(join(configRoot, 'plugins', 'cuppet-tui.js'), 'utf8'), { code: 'ENOENT' })
    const tuiConfig = JSON.parse(await readFile(join(configRoot, 'tui.json'), 'utf8')) as { plugin: string[] }
    assert.deepEqual(tuiConfig.plugin, [join(configRoot, 'tui-plugins', 'cuppet-tui.js')])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
