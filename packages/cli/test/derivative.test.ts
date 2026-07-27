import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isMermaidFence, renderMermaid } from '../src/opencode/mermaid.js'

test('supported Mermaid flowcharts become compact edges', () => {
  const result = renderMermaid('flowchart LR\n  API --> DB\n  DB --|writes|> Queue')
  assert.equal(result.kind, 'flowchart')
  if (result.kind === 'flowchart') {
    assert.deepEqual(result.edges, [
      { from: 'API', to: 'DB' },
      { from: 'DB', to: 'Queue', label: 'writes' },
    ])
    assert.match(result.text, /API → DB/)
  }
})

test('unsupported Mermaid remains intact code', () => {
  const source = 'sequenceDiagram\n  A->>B: hello'
  assert.deepEqual(renderMermaid(source), { kind: 'code', text: source })
  assert.equal(isMermaidFence(' Mermaid '), true)
})
