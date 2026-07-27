import assert from 'node:assert/strict'
import { test } from 'node:test'
import CuppetTuiPlugin, { formatStatus, modelSelectionSequence, uniqueModelRows } from '../src/tui.js'

test('native TUI model rows are unique and efforts follow model selection', () => {
  const rows = uniqueModelRows([
    { providerID: 'openai', modelID: 'gpt', name: 'GPT' },
    { providerID: 'openai', modelID: 'gpt', name: 'GPT [low]', variant: 'low' },
    { providerID: 'openai', modelID: 'gpt', name: 'GPT [high]', variant: 'high' },
  ])
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0]?.efforts, ['low', 'high'])
  assert.deepEqual(modelSelectionSequence(rows[0]!), ['model', 'effort'])
})

test('native TUI preserves Cuppet slash commands', async () => {
  const previousSocket = process.env.CUPPET_CONTROL_SOCKET
  const previousToken = process.env.CUPPET_CONTROL_TOKEN
  process.env.CUPPET_CONTROL_SOCKET = '/tmp/cuppet-test-control.sock'
  process.env.CUPPET_CONTROL_TOKEN = 'test-token'
  const layers: Array<{ commands: Array<{ slashName?: string; slashAliases?: string[] }> }> = []
  try {
    await CuppetTuiPlugin.tui({
      keymap: {
        registerLayer(layer: { commands: Array<{ slashName?: string; slashAliases?: string[] }> }) {
          layers.push(layer)
          return () => {}
        },
        dispatchCommand() {},
      },
      ui: { toast() {} },
    } as never)
  } finally {
    if (previousSocket === undefined) delete process.env.CUPPET_CONTROL_SOCKET
    else process.env.CUPPET_CONTROL_SOCKET = previousSocket
    if (previousToken === undefined) delete process.env.CUPPET_CONTROL_TOKEN
    else process.env.CUPPET_CONTROL_TOKEN = previousToken
  }
  const names = layers.flatMap((layer) => layer.commands.flatMap((command) => [
    ...(command.slashName ? [command.slashName] : []),
    ...(command.slashAliases ?? []),
  ]))
  assert.equal((layers[0] as { priority?: number } | undefined)?.priority, undefined)
  for (const name of [
    'status',
    'doctor',
    'memory',
    'memory-remember',
    'memory-forget',
    'memory-clear',
    'background',
    'background-pause',
    'background-resume',
    'platform',
    'login',
    'model',
    'effort',
    'steer',
    'steer-interrupt',
    'abort',
    'plan',
    'plan-agent',
    'compact',
    'undo',
  ]) assert.ok(names.includes(name), `missing /${name}`)
  for (const removed of ['cuppet-status', 'cuppet-compact', 'cuppet-undo']) {
    assert.equal(names.includes(removed), false, `unexpected /${removed}`)
  }
})

test('Cuppet status is formatted as a compact human-readable dialog', () => {
  const output = formatStatus({
    platform: 'vertex',
    session: { title: 'Improve status UI' },
    primary: { providerID: 'google-vertex', modelID: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', variant: 'high' },
    secondary: { providerID: 'google-vertex-anthropic', modelID: 'claude-sonnet', name: 'Claude Sonnet' },
    foreground: { usage: { input: 12_400, output: 820, reasoning: 210 }, cost: 0.42, running: false, steps: 3 },
    background: { paused: false, running: false, queued: 1, completed: 7, cost: 0.03 },
    tst: {
      project: { records: 12 },
      global: { records: 4 },
      stm_entries: 8,
      recovery_warnings: [],
      graph: { files: 93, symbols: 2445, edges: 20544, progress: { complete: true } },
    },
  })
  assert.match(output, /Platform\s+Vertex AI/)
  assert.match(output, /Gemini 3\.6 Flash · Vertex · high/)
  assert.match(output, /12\.4K in · 820 out · 210 reasoning · \$0\.42/)
  assert.match(output, /healthy/)
  assert.match(output, /93 files · 2\.4K syms · 20\.5K edges/)
  assert.doesNotMatch(output, /[{}\[\]"]/)
})
