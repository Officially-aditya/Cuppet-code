import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { IntegrationInfo } from '../src/types.js'
import { nextPermissionModal, previousModal } from '../src/ui/modal.js'
import { renderMessageLines, viewportLayout, windowMessageLines } from '../src/ui/viewport.js'
import { diffLineColor, formatDiff, formatToolDetail } from '../src/ui/TerminalApp.js'

test('Esc targets close command pickers and unwind nested authentication', () => {
  const integration = provider()
  assert.deepEqual(previousModal({ type: 'platform', required: false }), { type: 'none' })
  assert.deepEqual(previousModal({ type: 'model', role: 'primary', required: false }), { type: 'none' })
  assert.deepEqual(previousModal({ type: 'effort', role: 'primary', options: ['high'] }), { type: 'none' })
  assert.deepEqual(previousModal({ type: 'sessions', sessions: [] }), { type: 'none' })
  assert.deepEqual(previousModal({ type: 'login-key', integration }), {
    type: 'login-method',
    integration,
  })
  assert.deepEqual(previousModal({
    type: 'oauth-wait',
    integration,
    method: { id: 'browser', type: 'oauth', label: 'Browser' },
    attemptID: 'attempt',
    url: 'https://example.test',
    instructions: 'Continue in browser',
    mode: 'auto',
  }), {
    type: 'login-method',
    integration,
  })
  assert.deepEqual(previousModal({ type: 'model', role: 'secondary', required: true }), {
    type: 'model',
    role: 'primary',
    required: true,
  })
  assert.deepEqual(previousModal({ type: 'vertex-setup', required: true }), {
    type: 'platform',
    required: true,
  })
})

test('permission dismissal advances queued requests instead of abandoning them', () => {
  const first = { id: 'first', sessionID: 'session', action: 'edit', resources: ['one.ts'] }
  const second = { id: 'second', sessionID: 'session', action: 'bash', resources: ['npm test'] }
  assert.deepEqual(nextPermissionModal({ type: 'permission', request: first, queue: [second] }), {
    type: 'permission',
    request: second,
    queue: [],
  })
  assert.deepEqual(nextPermissionModal({ type: 'permission', request: second }), { type: 'none' })
})

test('viewport allocations never exceed the live terminal height', () => {
  for (let rows = 1; rows <= 80; rows += 1) {
    for (const modalOpen of [false, true]) {
      const layout = viewportLayout(rows, modalOpen)
      assert.equal(layout.header + layout.messages + layout.editor + layout.modal + layout.footer, rows)
      assert.equal(layout.messages + layout.editor + layout.modal, layout.body)
    }
  }
})

test('long and ANSI-bearing messages are wrapped into a bounded line window', () => {
  const lines = renderMessageLines([
    { id: 'one', sender: 'system', text: '\u001B[31mabcdefghijklmnopqrstuvwxyz\u001B[0m' },
    { id: 'two', sender: 'assistant', text: 'tail' },
  ], 8)
  assert.ok(lines.length > 4)
  assert.ok(lines.every((line) => !line.text.includes('\u001B')))
  assert.ok(lines.every((line) => Array.from(line.text).length <= 8))

  const latest = windowMessageLines(lines, 4, 0)
  assert.equal(latest.lines.length, 4)
  assert.equal(latest.offset, 0)
  assert.equal(latest.lines.at(-1)?.text, 'tail')

  const oldest = windowMessageLines(lines, 4, Number.MAX_SAFE_INTEGER)
  assert.equal(oldest.offset, oldest.maxOffset)
  assert.deepEqual(oldest.lines, lines.slice(0, 4))
})

test('formatToolDetail extracts file paths, commands, and search queries cleanly', () => {
  assert.equal(formatToolDetail('bash', { command: 'git status' }), 'git status')
  assert.equal(formatToolDetail('read_file', { file_path: 'package.json' }), 'package.json')
  assert.equal(formatToolDetail('edit_file', { file_path: 'src/cli.tsx', old_string: 'a', new_string: 'b' }), 'src/cli.tsx')
  assert.equal(formatToolDetail('write_file', { file_path: 'frontend/build/app.apk' }), 'frontend/build/app.apk')
  assert.equal(formatToolDetail('list_dir', { path: 'src/ui' }), 'src/ui')
  assert.equal(formatToolDetail('grep_search', { pattern: 'handleAgentEvent' }), 'handleAgentEvent')
  assert.equal(formatToolDetail('bash', 'npm test'), 'npm test')
  assert.equal(formatToolDetail('read_file', undefined), undefined)
})

test('tool messages render single gear icon and include details', () => {
  const lines = renderMessageLines([
    { id: 'tool-1', sender: 'tool', text: 'write_file (frontend/build/app.apk) · completed' },
  ], 80)
  assert.equal(lines[0]?.text, '⚙ write_file (frontend/build/app.apk) · completed')
})

test('diff rendering keeps filenames visible and colors only actual tool diff lines', () => {
  const rendered = formatDiff([{
    file: 'src/example.ts',
    before: 'const one = 1\nconst oldValue = 2\n',
    after: 'const one = 1\nconst newValue = 3\n',
    additions: 1,
    deletions: 1,
  }])
  const lines = rendered.split('\n')

  assert.equal(lines.at(-1), 'diff -- src/example.ts · +1 -1')
  assert.ok(lines.includes('-const oldValue = 2'))
  assert.ok(lines.includes('+const newValue = 3'))
  assert.equal(diffLineColor('--- a/src/example.ts', 'tool'), 'cyan')
  assert.equal(diffLineColor('+++ b/src/example.ts', 'tool'), 'cyan')
  assert.equal(diffLineColor('-old code', 'tool'), 'red')
  assert.equal(diffLineColor('+new code', 'tool'), 'green')
  assert.equal(diffLineColor('- ordinary assistant bullet', 'assistant'), undefined)
})

function provider(): IntegrationInfo {
  return {
    id: 'openai',
    name: 'OpenAI',
    methods: [{ id: 'browser', type: 'oauth', label: 'Browser' }],
    connections: [],
  }
}
