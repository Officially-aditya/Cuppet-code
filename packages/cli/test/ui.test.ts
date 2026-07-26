import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { IntegrationInfo, ModelInfo } from '../src/types.js'
import { nextPermissionModal, previousModal } from '../src/ui/modal.js'
import { renderMessageLines, viewportLayout, windowMessageLines } from '../src/ui/viewport.js'
import { diffLineColor, extractQuestion, formatDiff, formatToolDetail, formatToolDiff, formatToolLineStats, isQuestionRequest, modelPickerChoices } from '../src/ui/TerminalApp.js'

test('Esc targets close command pickers and unwind nested authentication', () => {
  const integration = provider()
  assert.deepEqual(previousModal({ type: 'platform', required: false }), { type: 'none' })
  assert.deepEqual(previousModal({ type: 'model', role: 'primary', required: false }), { type: 'none' })
  assert.deepEqual(previousModal({ type: 'effort', role: 'primary', options: ['high'] }), { type: 'none' })
  assert.deepEqual(previousModal({
    type: 'effort',
    role: 'primary',
    options: ['low', 'high'],
    model: { providerID: 'openai', modelID: 'gpt-test' },
    returnToModel: true,
    required: true,
  }), {
    type: 'model',
    role: 'primary',
    required: true,
  })
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

test('viewport reserves a physical terminal row for inline rendering', () => {
  for (let rows = 1; rows <= 80; rows += 1) {
    for (const modalOpen of [false, true]) {
      const layout = viewportLayout(rows, modalOpen)
      assert.equal(layout.terminalRows, rows)
      assert.equal(layout.reserved, 1)
      assert.equal(layout.rows, rows - layout.reserved)
      assert.ok(layout.rows < rows)
      assert.equal(layout.header + layout.messages + layout.editor + layout.modal + layout.footer, layout.rows)
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

test('formatToolLineStats calculates line additions and deletions for edit and write tools', () => {
  assert.equal(formatToolLineStats('Edit', { file_path: 'src/app.tsx', old_string: 'line1\nline2', new_string: 'lineA' }), '+1 -2')
  assert.equal(formatToolLineStats('Write', { file_path: 'src/new.ts', content: 'const x = 1\nconst y = 2\nconst z = 3' }), '+3')
  assert.equal(formatToolLineStats('NotebookEdit', { notebook_path: 'nb.ipynb', new_source: 'import numpy as np' }), '+1')
  assert.equal(formatToolLineStats('Read', { file_path: 'package.json' }), undefined)
})

test('formatToolDiff generates formatted diff code blocks for file modifications', () => {
  const editDiff = formatToolDiff('Edit', { file_path: 'src/app.tsx', old_string: 'old line', new_string: 'new line' })
  assert.ok(editDiff?.includes('diff -- src/app.tsx'))
  assert.ok(editDiff?.includes('-old line'))
  assert.ok(editDiff?.includes('+new line'))

  const writeDiff = formatToolDiff('Write', { file_path: 'src/new.ts', content: 'const x = 1' })
  assert.ok(writeDiff?.includes('diff -- src/new.ts'))
  assert.ok(writeDiff?.includes('+const x = 1'))

  assert.equal(formatToolDiff('Read', { file_path: 'package.json' }), undefined)
})

test('tool messages render single gear icon and include details', () => {
  const lines = renderMessageLines([
    { id: 'tool-1', sender: 'tool', text: 'write_file (frontend/build/app.apk) · completed' },
  ], 80)
  assert.equal(lines[0]?.text, '⚙ write_file (frontend/build/app.apk) · completed')
})

test('model picker groups variants into one model and exposes their effort levels', () => {
  const choices = modelPickerChoices([
    pickerModel('gpt-test', 'GPT Test'),
    pickerModel('gpt-test', 'GPT Test [low]', 'low'),
    pickerModel('gpt-test', 'GPT Test [high]', 'high'),
    pickerModel('reasoner', 'Reasoner [medium]', 'medium'),
  ])

  assert.deepEqual(choices, [
    {
      model: { providerID: 'openai', modelID: 'gpt-test' },
      name: 'GPT Test',
      efforts: ['low', 'high'],
    },
    {
      model: { providerID: 'openai', modelID: 'reasoner' },
      name: 'Reasoner',
      efforts: ['medium'],
    },
  ])
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

  assert.equal(lines[0], 'diff -- src/example.ts · +1 -1')
  assert.ok(lines.includes('-const oldValue = 2'))
  assert.ok(lines.includes('+const newValue = 3'))

  const genericDiff = formatDiff([{
    file: 'file',
    before: '',
    after: 'GITIGNORE_UPDATED.md',
  }])
  assert.equal(genericDiff, '+GITIGNORE_UPDATED.md')

  assert.equal(diffLineColor('--- a/src/example.ts', 'tool'), 'cyan')
  assert.equal(diffLineColor('+++ b/src/example.ts', 'tool'), 'cyan')
  assert.equal(diffLineColor('-old code', 'tool'), 'red')
  assert.equal(diffLineColor('+new code', 'tool'), 'green')
  assert.equal(diffLineColor('- ordinary assistant bullet', 'assistant'), undefined)
})

test('fenced code blocks expose structured metadata without legacy rails', () => {
  const lines = renderMessageLines([
    {
      id: 'msg-1',
      sender: 'assistant',
      text: 'Here is code:\n```typescript\n  const x = 1\n```',
    },
  ], 80)

  assert.equal(lines[0]?.text, 'Here is code:')
  assert.equal(lines[0]?.kind, 'text')
  assert.deepEqual(lines[1] && { kind: lines[1].kind, text: lines[1].text, language: lines[1].language }, {
    kind: 'code-header',
    text: 'typescript',
    language: 'typescript',
  })
  assert.deepEqual(lines[2] && { kind: lines[2].kind, text: lines[2].text, language: lines[2].language }, {
    kind: 'code',
    text: '  const x = 1',
    language: 'typescript',
  })
  assert.equal(lines[2]?.isCodeBlock, true)
  assert.doesNotMatch(lines.map((line) => line.text).join('\n'), /```|┌──|└──|│/)
})

test('Mermaid flowmaps and Markdown tables render as compact terminal layouts', () => {
  const lines = renderMessageLines([
    {
      id: 'visuals',
      sender: 'assistant',
      text: [
        'Project Flowmap',
        '',
        '```mermaid',
        'flowchart TD',
        'A[Flutter App Launch] --> B{Authenticated?}',
        'B -- Yes --> C[Inbox]',
        '```',
        '',
        '| Layer | Responsibility |',
        '| --- | --- |',
        '| Frontend | Flutter |',
        '| Backend | Fastify |',
        '',
        'Done.',
      ].join('\n'),
    },
  ], 80)
  const output = lines.map((line) => line.text).join('\n')

  assert.ok(lines.some((line) => line.kind === 'diagram-header' && line.text === 'Flowmap'))
  assert.ok(lines.some((line) => line.kind === 'diagram-edge' && line.text === 'Flutter App Launch → Authenticated?'))
  assert.ok(lines.some((line) => line.kind === 'diagram-edge' && line.text === 'Authenticated? — Yes → Inbox'))
  assert.ok(lines.some((line) => line.kind === 'table-header' && line.text.includes('Layer') && line.text.includes('Responsibility')))
  assert.ok(lines.some((line) => line.kind === 'table-divider' && line.text.includes('┼')))
  assert.ok(lines.some((line) => line.kind === 'table-row' && line.text.includes('Frontend') && line.text.includes('Flutter')))
  assert.doesNotMatch(output, /flowchart TD|A\[Flutter App Launch\]|```/)
  assert.ok(lines.every((line) => line.text.trim().length > 0), 'blank Markdown rows should not become empty terminal rows')
})

test('question permission requests are detected and extracted into structured question details', () => {
  const askReq = {
    id: 'req-1',
    sessionID: 'session-1',
    action: 'AskUserQuestion',
    resources: [],
    metadata: {
      questions: [
        {
          header: 'Auth Method',
          question: 'Which authentication method should we use?',
          options: [
            { label: 'JWT', description: 'Stateless tokens' },
            { label: 'Session', description: 'Cookie-based' },
          ],
        },
      ],
    },
  }

  assert.ok(isQuestionRequest(askReq))
  const extracted = extractQuestion(askReq)
  assert.equal(extracted.header, 'Auth Method')
  assert.equal(extracted.questionText, 'Which authentication method should we use?')
  assert.equal(extracted.options.length, 2)
  assert.equal(extracted.options[0]?.label, 'JWT')
  assert.equal(extracted.options[0]?.description, 'Stateless tokens')
  assert.equal(extracted.options[1]?.value, 'Session')

  const freeformReq = {
    id: 'req-2',
    sessionID: 'session-1',
    action: 'ask_user',
    resources: ['What project name should we use?'],
  }

  assert.ok(isQuestionRequest(freeformReq))
  const freeformExtracted = extractQuestion(freeformReq)
  assert.equal(freeformExtracted.questionText, 'What project name should we use?')
  assert.equal(freeformExtracted.options.length, 0)
})

function provider(): IntegrationInfo {
  return {
    id: 'openai',
    name: 'OpenAI',
    methods: [{ id: 'browser', type: 'oauth', label: 'Browser' }],
    connections: [],
  }
}

function pickerModel(modelID: string, name: string, variant?: string): ModelInfo {
  return {
    providerID: 'openai',
    modelID,
    ...(variant ? { variant } : {}),
    name,
    context: 128_000,
    output: 16_000,
    enabled: true,
    status: 'active',
    inputCost: 1,
    outputCost: 1,
    capabilities: { tools: true, input: ['text'], output: ['text'] },
  }
}
