import assert from 'node:assert/strict'
import { test } from 'node:test'
import CuppetTuiPlugin, {
  formatDoctor,
  formatMemory,
  formatRemoteControl,
  formatStatus,
  modelSelectionSequence,
  nextPlanAgent,
  planMessage,
  removedMessage,
  uniqueModelRows,
} from '../src/tui.js'

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
  const layers: Array<{ commands: Array<{ name?: string; slashName?: string; slashAliases?: string[] }> }> = []
  try {
    await CuppetTuiPlugin.tui({
      keymap: {
        registerLayer(layer: { commands: Array<{ name?: string; slashName?: string; slashAliases?: string[] }> }) {
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
    'remote',
    'remote-control',
    'remote-stop',
    'memory',
    'auto',
    'background',
    'orchestrator',
    'platform',
    'login',
    'model',
    'effort',
    'steer',
    'abort',
    'plan',
    'compact',
    'undo',
  ]) assert.ok(names.includes(name), `missing /${name}`)
  for (const removed of [
    'cuppet-status', 'cuppet-compact', 'cuppet-undo',
    'memory-remember', 'memory-forget', 'memory-clear',
    'background-pause', 'background-resume', 'steer-interrupt', 'plan-agent',
  ]) {
    assert.equal(names.includes(removed), false, `unexpected /${removed}`)
  }
})

test('/plan toggles directly between native plan and build agents', () => {
  assert.equal(nextPlanAgent('build'), 'plan')
  assert.equal(nextPlanAgent({ name: 'plan' }), 'build')
  assert.equal(nextPlanAgent(undefined), 'plan')
})

test('remote control formatting keeps pairing details readable', () => {
  const output = formatRemoteControl({
    running: true,
    hostId: 'host_test',
    deviceName: 'MacBook',
    invite: {
      code: 'ABC123',
      expiresAt: Date.parse('2026-08-25T12:00:00.000Z'),
      url: 'https://relay.example.com/app?code=ABC123',
    },
  })
  assert.match(output, /Host\s+MacBook · host_test/)
  assert.match(output, /Pairing code\s+ABC123/)
  assert.match(output, /Pairing URL\s+https:\/\/relay\.example\.com\/app\?code=ABC123/)
  assert.match(output, /Expires\s+2026-08-25T12:00:00\.000Z/)
})

test('remote setup formatting exposes approval details immediately', () => {
  const output = formatRemoteControl({
    running: false,
    starting: true,
    setup: {
      code: 'ABC-123-xyz',
      url: 'cuppet://remote/setup?session=setup_123&code=ABC-123-xyz',
      expiresAt: Date.parse('2026-08-25T12:00:00.000Z'),
      qr: 'QR-CONTENT',
    },
  })
  assert.match(output, /Scan or open this link/)
  assert.match(output, /cuppet:\/\/remote\/setup/)
  assert.match(output, /QR-CONTENT/)
  assert.match(output, /waiting for approval/)
})

test('Cuppet status is formatted as a compact human-readable dialog', () => {
  const output = formatStatus({
    platform: 'vertex',
    session: { title: 'Improve status UI' },
    primary: { providerID: 'google-vertex', modelID: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', variant: 'high' },
    secondary: { providerID: 'google-vertex-anthropic', modelID: 'claude-sonnet', name: 'Claude Sonnet' },
    foreground: { usage: { input: 12_400, output: 820, reasoning: 210 }, cost: 0.42, running: false, steps: 3 },
    approval: { auto: true },
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
  assert.match(output, /Approvals\s+auto · guarded workspace mode/)
  assert.match(output, /healthy/)
  assert.match(output, /93 files · 2\.4K syms · 20\.5K edges/)
  assert.doesNotMatch(output, /[{}\[\]"]/)
})

test('doctor, memory, and action results never expose raw JSON', () => {
  const doctor = formatDoctor({
    platform: 'darwin-arm64', node: 'v22.21.0', runtimeSource: 'package',
    opencode: { available: true, models: 254, providerCatalogSize: 172, providers: [{ connected: true }, { connected: false }] },
    vertex: { connected: true, primaryCompatibleModels: 145 },
    tst: { protocol: 'cuppet.tst.v3', graph: { files: 93, symbols: 2445, progress: { complete: true } } },
    storage: { permissions: { project: { available: true }, global: { available: true } } },
  })
  const memory = formatMemory({ tst: {
    project: { records: 12, wal_bytes: 2048 }, global: { records: 4, wal_bytes: 1024 },
    stm_entries: 8, sessions: 2, recovery_warnings: [],
    graph: { files: 93, symbols: 2445, edges: 20544, progress: { complete: true } },
  } })
  assert.match(doctor, /Engine\s+ready · 254 models/)
  assert.match(doctor, /Vertex AI\s+connected · 145 coding models/)
  assert.match(memory, /Project\s+12 records · 2 KB WAL/)
  assert.match(memory, /Graph\s+ready · 93 files · 2\.4K syms · 20\.5K edges/)
  assert.equal(removedMessage({ removed: 1 }), '1 memory record removed.')
  assert.equal(removedMessage(0), 'No matching memory records found.')
  assert.equal(planMessage({ enabled: true }), 'Plan mode enabled.')
  assert.equal(planMessage({ agent: 'build', enabled: true }), 'Plan mode disabled.')
  assert.doesNotMatch(`${doctor}\n${memory}`, /[{}\[\]"]/)
})
