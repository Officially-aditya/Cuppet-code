import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  clearCuppetContextState,
  explorerTaskBlockedForSession,
  renderCuppetContext,
  selectModelHistory,
  transformCuppetModelContext,
} from '../src/context.js'

function turn(index: number, text = `request ${index}`) {
  return [
    {
      info: { id: `user-${index}`, role: 'user' },
      parts: [{ type: 'text', text }],
    },
    {
      info: { id: `assistant-${index}`, role: 'assistant', parentID: `user-${index}`, finish: 'stop' },
      parts: [{ type: 'text', text: `outcome ${index} ${'x'.repeat(1_000)}` }],
    },
  ]
}

test('adaptive history keeps two complete recent turns and omits only whole turns', () => {
  const messages = Array.from({ length: 6 }, (_, index) => turn(index)).flat()
  const result = selectModelHistory(messages, { estimatedTokens: 80_000, usableTokens: 100_000 })
  assert.equal(result.trimmed, true)
  assert.ok(result.omitted.length >= 1)
  assert.equal(result.selected[0]?.info.role, 'user')
  assert.equal(result.selected.at(-2)?.info.id, 'user-5')
  assert.equal(result.selected.at(-1)?.info.id, 'assistant-5')
  assert.ok(result.selected.some((message) => message.info.id === 'user-4'))
})

test('live transform queries with the real prompt, formats STM and graph, and never changes persisted messages', async () => {
  const persisted = Array.from({ length: 6 }, (_, index) => turn(index, index === 5 ? 'Fix createTask in src/api.ts' : undefined)).flat()
  const output = { messages: structuredClone(persisted) }
  let query = ''
  let observations = 0
  const client = {
    async prepareContext(_sessionID: string, nextQuery: string, _hints: string[], records: unknown[]) {
      query = nextQuery
      observations = records.length
      return {
        observation_complete: true,
        stm: [{ key: 'current requirement', value: 'Preserve the task API', provenance: 'model_candidate', evidence: [] }],
        ltm: [{ key: 'style', value: 'Use strict TypeScript', provenance: 'explicit_user', evidence: [{}] }],
        graph: [{ node: { path: 'src/api.ts', name: 'createTask', symbol_kind: 'function', signature: 'createTask(input)', span: { start_row: 4, start_column: 1 } } }],
        edges: [{
          from: { path: 'src/api.ts', symbol: 'createTask', kind: 'function', line: 5, column: 2 },
          to: { path: 'src/store.ts', symbol: 'saveTask', kind: 'function', line: 8, column: 1 },
          kind: 'call',
        }],
      }
    },
  }
  await transformCuppetModelContext({
    sessionID: 'session-a',
    agent: 'cuppet',
    phase: 'foreground',
    history: { estimatedTokens: 80_000, usableTokens: 100_000 },
  }, output, client as never)

  assert.equal(query, 'Fix createTask in src/api.ts')
  assert.ok(observations > 0)
  assert.ok(output.messages.length < persisted.length)
  const context = String(output.messages.at(-2)?.parts[0]?.text)
  assert.match(context, /SESSION CONTINUITY \(STM\)/)
  assert.match(context, /TREE-SITTER CODE GRAPH/)
  assert.match(context, /src\/api\.ts:5:2 function createTask --call-->/)
  assert.doesNotMatch(JSON.stringify(persisted), /CUPPET_CONTEXT/)
  assert.equal(persisted.length, 12)
})

test('background and compaction requests are not transformed', async () => {
  const output = { messages: turn(0) }
  let calls = 0
  const client = { async prepareContext() { calls += 1 } }
  await transformCuppetModelContext({
    sessionID: 'background', agent: 'cuppet-background', phase: 'foreground',
    history: { estimatedTokens: 1, usableTokens: 1 },
  }, output, client as never)
  await transformCuppetModelContext({
    sessionID: 'compact', agent: 'compaction', phase: 'compaction',
    history: { estimatedTokens: 1, usableTokens: 1 },
  }, output, client as never)
  assert.equal(calls, 0)
})

test('plan retrieval receives a larger bounded context without raw JSON', () => {
  const block = renderCuppetContext({
    observation_complete: true,
    stm: [{ key: 'requirement', value: 'Keep permissions native', provenance: 'explicit_user' }],
    graph: [{ node: { path: 'src/main.ts', name: 'main', symbol_kind: 'function' } }],
  }, 128_000, true)
  assert.match(block, /^<CUPPET_PLAN_MODE_CONTEXT/)
  assert.match(block, /budget_tokens="15360"/)
  assert.match(block, /WORKSPACE CODE MAP UNAVAILABLE/)
  assert.match(block, /explorer\/task fallback remains available/)
  assert.doesNotMatch(block, /\{"/)
  assert.ok(block.length <= 15_360 * 4)
})

function completeProjection() {
  return {
    complete: true,
    coverage: {
      indexing_complete: true,
      indexed_files: 2,
      indexed_modules: 2,
      indexed_symbols: 2,
      indexed_dependencies: 2,
      included_files: 2,
      included_modules: 2,
      included_symbols: 2,
      included_dependencies: 2,
    },
    files: ['src/', '  api.ts', '  store.ts'],
    modules: [{ path: 'src/api.ts', imports: ['src/store.ts'], exports: [], implementations: [], tests: [] }],
    symbols: [{ path: 'src/api.ts', name: 'createTask', kind: 'function', signature: 'function createTask()', line: 2, column: 1 }],
    omissions: { files: 0, modules: 0, symbols: 0, dependencies: 0, unfinished_files: 0 },
  }
}

test('plan transform receives the 12% budget split, injects ephemeral projection context, and blocks explorer tasks', async () => {
  clearCuppetContextState()
  let mode = ''
  let projectionBudget = 0
  const client = {
    async prepareContext(_sessionID: string, _query: string, _hints: string[], _records: unknown[], nextMode: string, nextBudget: number) {
      mode = nextMode
      projectionBudget = nextBudget
      return {
        stm: [{ key: 'goal', value: 'Keep the task API stable', provenance: 'explicit_user', evidence: [] }],
        ltm: [], graph: [], edges: [], plan_projection: completeProjection(),
      }
    },
  }
  const output = { messages: turn(0, 'Plan the task API') }
  const persisted = structuredClone(output.messages)
  await transformCuppetModelContext({
    sessionID: 'plan-session-a',
    agent: 'plan',
    phase: 'foreground',
    history: { estimatedTokens: 1, usableTokens: 200_000 },
  }, output, client as never)

  assert.equal(mode, 'plan')
  assert.equal(projectionBudget, Math.floor(16_384 * 0.70))
  const context = String(output.messages.at(-2)?.parts[0]?.text)
  assert.match(context, /WORKSPACE CODE MAP \(complete\)/)
  assert.match(context, /src\/api\.ts/)
  assert.match(context, /SESSION CONTINUITY \(STM\)/)
  assert.doesNotMatch(context, /\{"/)
  assert.deepEqual(persisted, turn(0, 'Plan the task API'))
  assert.equal(explorerTaskBlockedForSession('plan-session-a', { tool: 'task' }, { subagent_type: 'explorer' }), true)
  assert.equal(explorerTaskBlockedForSession('plan-session-b', { tool: 'task' }, { subagent_type: 'explorer' }), false)
  assert.equal(explorerTaskBlockedForSession('plan-session-a', { agent: 'build', tool: 'task' }, { subagent_type: 'explorer' }), false)

  await transformCuppetModelContext({
    sessionID: 'plan-session-a',
    agent: 'build',
    phase: 'foreground',
    history: { estimatedTokens: 1, usableTokens: 100_000 },
  }, { messages: turn(1, 'Build the task API') }, client as never)
  assert.equal(explorerTaskBlockedForSession('plan-session-a', { tool: 'task' }, { subagent_type: 'explorer' }), false)
  clearCuppetContextState()
})

test('incomplete plan projections explain omissions and retain explorer fallback', async () => {
  clearCuppetContextState()
  const output = { messages: turn(0, 'Plan an unfinished graph') }
  const client = {
    async prepareContext() {
      return {
        stm: [], ltm: [], graph: [],
        plan_projection: {
          complete: false,
          coverage: { indexing_complete: false },
          files: ['src/'], modules: [], symbols: [],
          omissions: { files: 2, modules: 0, symbols: 0, dependencies: 0, unfinished_files: 2 },
        },
      }
    },
  }
  await transformCuppetModelContext({
    sessionID: 'incomplete-plan', agent: 'plan', phase: 'foreground',
    history: { estimatedTokens: 1, usableTokens: 10_000 },
  }, output, client as never)
  const context = String(output.messages.at(-2)?.parts[0]?.text)
  assert.match(context, /INCOMPLETE/)
  assert.match(context, /FALLBACK: TST indexing is unfinished/)
  assert.equal(explorerTaskBlockedForSession('incomplete-plan', { tool: 'task' }, { subagent_type: 'explorer' }), false)
  clearCuppetContextState()
})

test('TST failure is injected as an explicit plan fallback without persisted synthetic messages', async () => {
  clearCuppetContextState()
  const output = { messages: turn(0, 'Plan while TST is offline') }
  const client = {
    async prepareContext() {
      throw new Error('socket unavailable')
    },
  }
  await transformCuppetModelContext({
    sessionID: 'offline-plan', agent: 'plan', phase: 'foreground',
    history: { estimatedTokens: 1, usableTokens: 10_000 },
  }, output, client as never)
  const context = String(output.messages.at(-2)?.parts[0]?.text)
  assert.match(context, /WORKSPACE CODE MAP UNAVAILABLE/)
  assert.match(context, /socket unavailable/)
  assert.match(context, /explorer\/task fallback remains available/)
  clearCuppetContextState()
})
