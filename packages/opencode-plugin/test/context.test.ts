import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import {
  clearCuppetContextState,
  renderCompiledContext,
  explorerTaskBlockedForSession,
  renderCuppetContext,
  renderGraphCapsuleContext,
  renderStmEventContext,
  renderStmOnlyContext,
  parseTaskSpec,
  selectCurrentTurnHistory,
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

function syntheticPart(messages: any[]) {
  return messages
    .flatMap((message) => message.parts ?? [])
    .filter((part) => part.synthetic === true && typeof part.text === 'string')
    .at(-1)
}

function syntheticText(messages: any[]): string {
  return String(syntheticPart(messages)?.text)
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

test('STM-event history keeps only the active turn and omits completed transcript turns', () => {
  const messages = Array.from({ length: 3 }, (_, index) => turn(index)).flat()
  const result = selectCurrentTurnHistory(messages)
  assert.equal(result.trimmed, true)
  assert.equal(result.omitted.length, 2)
  assert.equal(result.selected[0]?.info.id, 'user-2')
  assert.equal(result.selected.at(-1)?.info.id, 'assistant-2')
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
  const context = syntheticText(output.messages)
  assert.equal(syntheticPart(output.messages)?.synthetic, true)
  assert.match(context, /SESSION CONTINUITY \(STM\)/)
  assert.match(context, /TREE-SITTER CODE GRAPH/)
  assert.match(context, /src\/api\.ts:5:2 function createTask --call-->/)
  assert.doesNotMatch(JSON.stringify(output.messages.filter((message) => message.info.id !== 'user-5')), /CUPPET_CONTEXT/)
  assert.doesNotMatch(JSON.stringify(persisted), /CUPPET_CONTEXT/)
  assert.equal(persisted.length, 12)
})

test('request-scoped context is appended after the prompt and closes the prior foreground turn', async () => {
  clearCuppetContextState()
  let completed = 0
  let prepared = 0
  const client = {
    async prepareContext() {
      prepared += 1
      return {
        observation_complete: true,
        stm: [{ key: 'continuity', value: `Keep the API stable (${prepared})`, provenance: 'model_candidate', evidence: [] }],
        ltm: [], graph: [], edges: [],
      }
    },
    async turnCompleted() {
      completed += 1
    },
  }
  const first = { messages: turn(0, 'Build the first task') }
  await transformCuppetModelContext({
    sessionID: 'cache-session', agent: 'cuppet', phase: 'foreground',
    history: { estimatedTokens: 1, usableTokens: 100_000 },
  }, first, client as never)
  assert.equal(syntheticPart(first.messages)?.synthetic, true)
  assert.doesNotMatch(JSON.stringify(first.messages.filter((message) => message.info.id !== 'user-0')), /CUPPET_CONTEXT/)
  const firstContext = syntheticText(first.messages)

  const second = { messages: [...turn(0, 'Build the first task'), ...turn(1, 'Build the next task')] }
  await transformCuppetModelContext({
    sessionID: 'cache-session', agent: 'cuppet', phase: 'foreground',
    history: { estimatedTokens: 1, usableTokens: 100_000 },
  }, second, client as never)
  assert.equal(completed, 1)
  assert.equal(syntheticPart(second.messages)?.synthetic, true)
  assert.match(syntheticText(second.messages.filter((message) => message.info.id === 'user-0')), /Keep the API stable \(1\)/)
  const secondContext = syntheticText(second.messages.filter((message) => message.info.id === 'user-1'))
  assert.match(secondContext, /Keep the API stable \(2\)/)
  assert.notEqual(firstContext, secondContext)
  assert.equal(second.messages.filter((message) => (message.info as Record<string, unknown>).synthetic === true).length, 0)
  assert.equal(second.messages.flatMap((message) => message.parts).filter((part) => (part as Record<string, unknown>).synthetic === true).length, 2)

  const repeated = { messages: structuredClone(second.messages) }
  await transformCuppetModelContext({
    sessionID: 'cache-session', agent: 'cuppet', phase: 'foreground',
    history: { estimatedTokens: 1, usableTokens: 100_000 },
  }, repeated, client as never)
  assert.equal(prepared, 2, 'TST retrieval runs once per user message, not once per model step')
  assert.equal(syntheticText(repeated.messages.filter((message) => message.info.id === 'user-1')), secondContext)
  clearCuppetContextState()
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

test('model-facing prefix stays byte-identical across steps and turns for stable provider caching', async () => {
  clearCuppetContextState()
  let prepared = 0
  const client = {
    async prepareContext() {
      prepared += 1
      return {
        observation_complete: true,
        stm: [{ key: 'continuity', value: `Keep the API stable (${prepared})`, provenance: 'model_candidate', evidence: [] }],
        ltm: [], graph: [], edges: [],
      }
    },
    async turnCompleted() {},
  }
  const options = {
    sessionID: 'cache-prefix-session', agent: 'cuppet', phase: 'foreground',
    history: { estimatedTokens: 1, usableTokens: 100_000 },
  }

  const stepOne = { messages: [...turn(0), ...turn(1), ...turn(2), {
    info: { id: 'user-3', role: 'user' },
    parts: [{ type: 'text', text: 'Build feature three' }],
  }] }
  await transformCuppetModelContext(options, stepOne, client as never)
  const renderedStepOne = stepOne.messages.map((message) => JSON.stringify(message))

  // Mid-turn: assistant/tool parts accumulate; every prior message must stay byte-identical.
  const stepTwo = { messages: structuredClone(stepOne.messages).concat([{
    info: { id: 'assistant-tool-3', role: 'assistant', parentID: 'user-3', finish: 'tool-calls' },
    parts: [{ type: 'text', text: 'running tools' }],
  }]) }
  await transformCuppetModelContext(options, stepTwo, client as never)
  const renderedStepTwo = stepTwo.messages.map((message) => JSON.stringify(message))
  assert.equal(renderedStepTwo.length, renderedStepOne.length + 1)
  renderedStepOne.forEach((rendered, index) => {
    assert.equal(renderedStepTwo[index], rendered, `message ${index} must be byte-identical across steps`)
  })
  assert.equal(prepared, 1, 'mid-turn steps must replay the memoized block without new retrieval')

  // Next user turn: prior turns (including their replayed blocks) must remain unchanged.
  const nextTurn = { messages: [...structuredClone(stepOne.messages), {
    info: { id: 'assistant-3', role: 'assistant', parentID: 'user-3', finish: 'stop' },
    parts: [{ type: 'text', text: 'outcome 3' }],
  }, ...turn(4, 'Build feature four')] }
  await transformCuppetModelContext(options, nextTurn, client as never)
  const renderedNext = nextTurn.messages.map((message) => JSON.stringify(message))
  assert.equal(renderedNext.length, renderedStepOne.length + 3)
  renderedStepOne.forEach((rendered, index) => {
    assert.equal(renderedNext[index], rendered, `message ${index} must be byte-identical into the next turn`)
  })
  assert.equal(prepared, 2, 'a new user message triggers exactly one fresh retrieval')
  assert.match(syntheticText(nextTurn.messages.filter((message) => message.info.id === 'user-4')), /Keep the API stable \(2\)/)
  clearCuppetContextState()
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
  const context = syntheticText(output.messages)
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
  const context = syntheticText(output.messages)
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
  const context = syntheticText(output.messages)
  assert.match(context, /WORKSPACE CODE MAP UNAVAILABLE/)
  assert.match(context, /socket unavailable/)
  assert.match(context, /explorer\/task fallback remains available/)
  clearCuppetContextState()
})

test('STM-only rendering excludes LTM, graph, projections, and raw JSON', () => {
  const block = renderStmOnlyContext({
    stm: [{
      key: 'requirement',
      value: 'Preserve src/api.ts',
      provenance: 'model_candidate',
      evidence: [],
      file_hashes: { 'src/api.ts': 'hash' },
    }],
    ltm: [{ key: 'must-not-appear', value: 'durable' }],
    graph: [{ node: { path: 'src/graph.ts', name: 'graphOnly' } }],
    plan_projection: { files: ['src/graph.ts'] },
  }, 100_000)
  assert.match(block, /^<CUPPET_STM_CONTEXT/)
  assert.match(block, /src\/api\.ts/)
  assert.doesNotMatch(block, /must-not-appear/)
  assert.doesNotMatch(block, /graphOnly/)
  assert.doesNotMatch(block, /plan_projection/)
  assert.doesNotMatch(block, /\{"/)
  assert.doesNotMatch(block, /<CUPPET_CONTEXT/)
})

test('graph capsule rendering is graph-only and capped at 768 tokens', () => {
  const block = renderGraphCapsuleContext({
    stm: [{ key: 'excluded-stm', value: 'no' }],
    ltm: [{ key: 'excluded-ltm', value: 'no' }],
    graph: [{
      node: {
        path: 'src/auth.ts',
        name: 'AuthService',
        symbol_kind: 'class',
        signature: 'class AuthService',
        span: { start_row: 3, start_column: 0 },
      },
    }],
    edges: [{
      from: { path: 'src/auth.ts', symbol: 'AuthService', kind: 'class', line: 4, column: 1 },
      to: { path: 'src/session.ts', symbol: 'SessionStore', kind: 'class', line: 8, column: 1 },
      kind: 'dependency',
    }],
  }, 100_000)
  assert.match(block, /^<CUPPET_CONTEXT mode="graph_only"/)
  assert.match(block, /src\/auth\.ts/)
  assert.match(block, /AuthService/)
  assert.doesNotMatch(block, /excluded-stm|excluded-ltm/)
  assert.ok(block.length <= 768 * 4)
})

test('graph capsule experiment replaces the ordinary STM/LTM projection', () => {
  const previous = process.env.CUPPET_GRAPH_CAPSULE_ONLY
  process.env.CUPPET_GRAPH_CAPSULE_ONLY = '1'
  try {
    const block = renderCuppetContext({
      stm: [{ key: 'excluded-stm', value: 'no' }],
      ltm: [{ key: 'excluded-ltm', value: 'no' }],
      graph: [{ node: { path: 'src/index.ts', name: 'main', symbol_kind: 'function' } }],
    }, 100_000, false)
    assert.match(block, /mode="graph_only"/)
    assert.match(block, /src\/index\.ts/)
    assert.doesNotMatch(block, /excluded-stm|excluded-ltm/)
  } finally {
    if (previous === undefined) delete process.env.CUPPET_GRAPH_CAPSULE_ONLY
    else process.env.CUPPET_GRAPH_CAPSULE_ONLY = previous
  }
})

test('source capsule includes selected workspace code and remains bounded', async () => {
  const previousRoot = process.env.CUPPET_PROJECT_ROOT
  process.env.CUPPET_PROJECT_ROOT = resolve(process.cwd(), '../..')
  try {
    const block = await renderCompiledContext({
      graph: [{ node: { path: 'packages/opencode-plugin/src/context.ts', name: 'transformCuppetModelContext', symbol_kind: 'function' } }],
      edges: [],
      stm: [],
      ltm: [],
    }, 'Inspect packages/opencode-plugin/src/context.ts before editing.', 100_000)
    assert.match(block, /^<CUPPET_COMPILED_CONTEXT mode="source_capsule"/)
    assert.match(block, /SOURCE SNAPSHOT/)
    assert.match(block, /FILE packages\/opencode-plugin\/src\/context\.ts/)
    assert.match(block, /import \{ createHash \}/)
    assert.doesNotMatch(block, /TREE-SITTER CODE GRAPH\n-.*SESSION CONTINUITY/)
    assert.ok(block.length <= 8_192 * 4)
  } finally {
    if (previousRoot === undefined) delete process.env.CUPPET_PROJECT_ROOT
    else process.env.CUPPET_PROJECT_ROOT = previousRoot
  }
})

test('task parser creates a hard extensionless directory scope and classifies task intent', () => {
  const create = parseTaskSpec('Build projects/todo-list-app with accessible localStorage persistence. Fix obvious issues before replying. Include semantic header/nav and contact/footer.')
  assert.equal(create.type, 'create')
  assert.deepEqual(create.scope, ['projects/todo-list-app'])
  assert.deepEqual(create.scopePrefixes, ['projects/todo-list-app'])
  assert.ok(!create.scope.includes('header/nav'))
  assert.ok(!create.scope.includes('contact/footer'))
  assert.ok(create.entities.includes('localStorage'))
  assert.ok(create.constraints.includes('accessible'))

  const refactor = parseTaskSpec('Refactor src/taskStore.ts and preserve existing behavior.')
  assert.equal(refactor.type, 'refactor')
  assert.deepEqual(refactor.scope, ['src/taskStore.ts'])
  assert.deepEqual(refactor.scopePrefixes, ['src'])
  assert.ok(refactor.constraints.includes('preserve-existing-behavior'))
})

test('compiled context projects the active turn and requests structured STM events', async () => {
  const previousCompiler = process.env.CUPPET_CONTEXT_COMPILER_AB
  const previousRoot = process.env.CUPPET_PROJECT_ROOT
  process.env.CUPPET_CONTEXT_COMPILER_AB = '1'
  process.env.CUPPET_PROJECT_ROOT = resolve(process.cwd(), '../..')
  clearCuppetContextState()
  let mode = ''
  const first = turn(0, 'Build the first task')
  first[1]!.parts.push({
    type: 'tool',
    tool: 'read',
    callID: 'read-1',
    state: { status: 'completed', input: 'packages/opencode-plugin/src/context.ts', output: 'source' },
  } as never)
  const output = { messages: [...first, ...turn(1, 'Continue packages/opencode-plugin/src/context.ts')] }
  const client = {
    async prepareContext(_sessionID: string, _query: string, _hints: string[], _observations: unknown[], nextMode: string) {
      mode = nextMode
      return {
        observation_complete: true,
        stm: [{ key: 'tool:read-1', value: '{"type":"tool_event","tool":"read","status":"completed"}', provenance: 'tool', evidence: [] }],
        ltm: [], graph: [], edges: [],
      }
    },
  }
  try {
    await transformCuppetModelContext({
      sessionID: 'compiled-history',
      agent: 'cuppet',
      phase: 'foreground',
      history: { estimatedTokens: 80_000, usableTokens: 100_000 },
    }, output, client as never)
    assert.equal(mode, 'stm_events')
    assert.equal(output.messages.some((message) => message.info.id === 'user-0'), false)
    assert.match(syntheticText(output.messages), /CUPPET_COMPILED_CONTEXT/)
    assert.match(syntheticText(output.messages), /tool:read-1/)
  } finally {
    if (previousCompiler === undefined) delete process.env.CUPPET_CONTEXT_COMPILER_AB
    else process.env.CUPPET_CONTEXT_COMPILER_AB = previousCompiler
    if (previousRoot === undefined) delete process.env.CUPPET_PROJECT_ROOT
    else process.env.CUPPET_PROJECT_ROOT = previousRoot
    clearCuppetContextState()
  }
})

test('task context ranks explicit source as high confidence and graph relationships as hypotheses', async () => {
  const previousTaskContext = process.env.CUPPET_TASK_CONTEXT_AB
  const previousRoot = process.env.CUPPET_PROJECT_ROOT
  process.env.CUPPET_TASK_CONTEXT_AB = '1'
  process.env.CUPPET_PROJECT_ROOT = resolve(process.cwd(), '../..')
  clearCuppetContextState()
  const output = { messages: turn(0, 'Update packages/opencode-plugin/src/context.ts to add deadline filtering around transformCuppetModelContext.') }
  const prefixes: string[] = []
  const client = {
    async graphQuery(_query: string, _limit: number, prefix?: string) {
      if (prefix) prefixes.push(prefix)
      return [{
        node: {
          path: 'packages/opencode-plugin/src/context.ts',
          name: 'transformCuppetModelContext',
          symbol_kind: 'function',
          span: { start_row: 232, end_row: 370 },
        },
        score: 90,
      }]
    },
    async graphSearch(pattern: string) {
      return { query: pattern, nodes: [], text_matches: [] }
    },
    async graphTraceSummary() {
      return {
        edges: [{
          from: {
            path: 'packages/opencode-plugin/src/context.ts',
            symbol: 'transformCuppetModelContext',
            kind: 'function',
            line: 233,
          },
          to: {
            path: 'packages/opencode-plugin/src/rpc.ts',
            symbol: 'TstToolClient',
            kind: 'class',
            line: 41,
          },
          kind: 'call',
        }],
      }
    },
  }
  try {
    await transformCuppetModelContext({
      sessionID: 'task-context-ranking',
      agent: 'cuppet',
      phase: 'foreground',
      history: { estimatedTokens: 80_000, usableTokens: 100_000 },
    }, output, client as never)
    const context = syntheticText(output.messages)
    assert.match(context, /^<CUPPET_TASK_CONTEXT mode="scoped_ranked_evidence"/)
    assert.match(context, /HIGH-CONFIDENCE SOURCE/)
    assert.match(context, /FILE packages\/opencode-plugin\/src\/context\.ts/)
    assert.match(context, /MEDIUM-CONFIDENCE HYPOTHESES/)
    assert.match(context, /packages\/opencode-plugin\/src\/rpc\.ts/)
    assert.doesNotMatch(context, /TREE-SITTER CODE GRAPH|SESSION CONTINUITY \(STM\)/)
    assert.deepEqual(prefixes, ['packages/opencode-plugin/src'])
  } finally {
    if (previousTaskContext === undefined) delete process.env.CUPPET_TASK_CONTEXT_AB
    else process.env.CUPPET_TASK_CONTEXT_AB = previousTaskContext
    if (previousRoot === undefined) delete process.env.CUPPET_PROJECT_ROOT
    else process.env.CUPPET_PROJECT_ROOT = previousRoot
    clearCuppetContextState()
  }
})

test('STM-event rendering sends structured execution records and excludes graph/LTM', () => {
  const block = renderStmEventContext({
    stm: [{
      key: 'tool:call-1',
      value: JSON.stringify({
        type: 'tool_event',
        tool: 'read',
        arguments: 'src/auth.ts',
        status: 'completed',
        result_artifact: 'artifact-123',
        paths: ['src/auth.ts'],
        symbols: ['AuthService'],
        revision: 'hash',
      }),
      provenance: 'tool',
    }],
    ltm: [{ key: 'must-not-appear', value: 'durable' }],
    graph: [{ node: { path: 'src/graph.ts', name: 'graphOnly' } }],
  }, 15_000)
  assert.match(block, /^<CUPPET_STM_EVENT_CONTEXT/)
  assert.match(block, /"tool":"read"/)
  assert.match(block, /"result_artifact":"artifact-123"/)
  assert.match(block, /"symbols":\["AuthService"\]/)
  assert.doesNotMatch(block, /must-not-appear|graphOnly|TREE-SITTER/)
  assert.ok(block.length <= 15_000 * 4)
})

test('opt-in STM-event context records tool metadata, uses stm_events, and refreshes per model step', async () => {
  const previous = process.env.CUPPET_STM_EVENT_CONTEXT
  process.env.CUPPET_STM_EVENT_CONTEXT = '1'
  try {
    clearCuppetContextState()
    let mode = ''
    let prepared = 0
    let observedTool: string | undefined
    const client = {
      async prepareContext(_sessionID: string, _query: string, hints: string[], records: any[], nextMode: string) {
        prepared += 1
        mode = nextMode
        assert.deepEqual(hints, [])
        const tool = records.find((record) => String(record.value).includes('"type":"tool_event"'))
        observedTool = tool?.value
        return {
          observation_complete: true,
          stm: tool ? [tool] : [],
          ltm: [{ key: 'excluded-ltm', value: 'no' }],
          graph: [{ node: { path: 'src/graph.ts', name: 'excludedGraph' } }],
        }
      },
    }
    const output: { messages: any[] } = { messages: [
      {
        info: { id: 'user-0', role: 'user' },
        parts: [{ type: 'text', text: 'Build the first app' }],
      },
      {
        info: { id: 'assistant-0', role: 'assistant' },
        parts: [{
          type: 'tool',
          tool: 'read',
          callID: 'call-1',
          state: {
            status: 'completed',
            input: { path: 'src/auth.ts' },
            output: 'export class AuthService {}',
          },
        }],
      },
      {
        info: { id: 'user-1', role: 'user' },
        parts: [{ type: 'text', text: 'Build the second app' }],
      },
    ] }
    await transformCuppetModelContext({
      sessionID: 'stm-events',
      agent: 'cuppet',
      phase: 'foreground',
      history: { estimatedTokens: 100_000, usableTokens: 100_000 },
    }, output, client as never)
    assert.equal(mode, 'stm_events')
    assert.match(observedTool ?? '', /"tool":"read"/)
    assert.match(observedTool ?? '', /"arguments":".*src\/auth\.ts/)
    assert.match(observedTool ?? '', /"status":"completed"/)
    assert.match(observedTool ?? '', /"result_artifact":"artifact-/)
    assert.match(observedTool ?? '', /"paths":\["src\/auth\.ts"\]/)
    assert.match(observedTool ?? '', /"symbols":\["AuthService"\]/)
    assert.equal(output.messages[0]?.info.id, 'user-1')
    assert.doesNotMatch(JSON.stringify(output.messages), /excluded-ltm|excludedGraph/)
    assert.match(syntheticText(output.messages), /CUPPET_STM_EVENT_CONTEXT/)

    const repeated = { messages: structuredClone(output.messages) }
    await transformCuppetModelContext({
      sessionID: 'stm-events',
      agent: 'cuppet',
      phase: 'foreground',
      history: { estimatedTokens: 100_000, usableTokens: 100_000 },
    }, repeated, client as never)
    assert.equal(prepared, 2)
  } finally {
    if (previous === undefined) delete process.env.CUPPET_STM_EVENT_CONTEXT
    else process.env.CUPPET_STM_EVENT_CONTEXT = previous
    clearCuppetContextState()
  }
})

test('opt-in STM-only foreground context uses stm_only and ignores synthetic prior context', async () => {
  const previous = process.env.CUPPET_STM_ONLY_COMPACTION
  process.env.CUPPET_STM_ONLY_COMPACTION = '1'
  try {
    let mode = ''
    let observations: unknown[] = []
    const client = {
      async prepareContext(_sessionID: string, _query: string, _hints: string[], records: unknown[], nextMode: string) {
        mode = nextMode
        observations = records
        return {
          observation_complete: true,
          stm: [{ key: 'stm requirement', value: 'Preserve src/api.ts', provenance: 'explicit_user', evidence: [] }],
          ltm: [{ key: 'excluded ltm', value: 'no' }],
          graph: [{ node: { path: 'src/graph.ts', name: 'excludedGraph' } }],
        }
      },
    }
    const output: { messages: any[]; [key: string]: any } = { messages: [{
      info: { id: 'u1', role: 'user' },
      parts: [
        { type: 'text', text: '<CUPPET_CONTEXT>synthetic old prompt</CUPPET_CONTEXT>', synthetic: true },
        { type: 'text', text: '<CUPPET_STM_CONTEXT>stale stm</CUPPET_STM_CONTEXT>', synthetic: true },
        { type: 'text', text: 'Fix src/api.ts' },
      ],
    }] }
    await transformCuppetModelContext({
      sessionID: 'stm-foreground',
      agent: 'cuppet',
      phase: 'foreground',
      history: { estimatedTokens: 1, usableTokens: 100_000 },
    }, output, client as never)
    assert.equal(mode, 'stm_only')
    assert.equal(observations.length, 0)
    const context = syntheticText(output.messages)
    assert.match(context, /CUPPET_STM_CONTEXT/)
    assert.match(context, /stm requirement/)
    assert.doesNotMatch(context, /excluded ltm|excludedGraph/)
    assert.doesNotMatch(JSON.stringify(output.messages), /synthetic old prompt|stale stm/)
  } finally {
    if (previous === undefined) delete process.env.CUPPET_STM_ONLY_COMPACTION
    else process.env.CUPPET_STM_ONLY_COMPACTION = previous
  }
})

test('STM-only compaction refreshes before writing a directive and excludes synthetic history', async () => {
  const previous = process.env.CUPPET_STM_ONLY_COMPACTION
  process.env.CUPPET_STM_ONLY_COMPACTION = '1'
  try {
    let request: Record<string, any> | undefined
    const client = {
      async refreshStm(input: Record<string, any>) {
        request = input
        return {
          records: [{ key: 'file anchor', value: 'src/api.ts', provenance: 'tool', evidence: [] }],
          paths: ['src/api.ts'],
        }
      },
    }
    const output: { messages: any[]; [key: string]: any } = { messages: [{
      info: { id: 'u2', role: 'user' },
      parts: [
        { type: 'text', text: '<CUPPET_CONTEXT>synthetic should be excluded</CUPPET_CONTEXT>', synthetic: true },
        { type: 'text', text: 'Fix src/api.ts and preserve the API' },
      ],
    }, {
      info: { id: 'a2', role: 'assistant' },
      parts: [{ type: 'text', text: 'Updated src/api.ts' }],
    }] }
    const before = structuredClone(output.messages)
    await transformCuppetModelContext({
      sessionID: 'stm-compaction',
      agent: 'compaction',
      phase: 'compaction',
      history: { estimatedTokens: 10_000, usableTokens: 10_000 },
    }, output, client as never)
    assert.ok(request)
    assert.equal(request?.session_id, 'stm-compaction')
    assert.match(JSON.stringify(request), /src\/api\.ts/)
    assert.doesNotMatch(JSON.stringify(request), /synthetic should be excluded/)
    assert.match(String(output.compactionDirective), /CUPPET_STM_COMPACTION/)
    assert.match(String(output.compactionDirective), /CUPPET_STM_CONTEXT/)
    assert.equal(output.cuppetCompactionAbort, false)
    assert.deepEqual(output.messages, before)
  } finally {
    if (previous === undefined) delete process.env.CUPPET_STM_ONLY_COMPACTION
    else process.env.CUPPET_STM_ONLY_COMPACTION = previous
  }
})

test('STM-only compaction emits an abort directive without mutating messages when refresh fails', async () => {
  const previous = process.env.CUPPET_STM_ONLY_COMPACTION
  process.env.CUPPET_STM_ONLY_COMPACTION = '1'
  try {
    const output: { messages: any[]; [key: string]: any } = { messages: turn(0, 'Fix src/api.ts') }
    const before = structuredClone(output.messages)
    await transformCuppetModelContext({
      sessionID: 'stm-failed',
      agent: 'compaction',
      phase: 'compaction',
      history: { estimatedTokens: 10_000, usableTokens: 10_000 },
    }, output, { async refreshStm() { throw new Error('refresh unavailable') } } as never)
    assert.equal(output.cuppetCompactionAbort, true)
    assert.match(String(output.compactionDirective), /ABORT STM-only compaction/)
    assert.match(String(output.compactionDirective), /refresh unavailable/)
    assert.deepEqual(output.messages, before)
  } finally {
    if (previous === undefined) delete process.env.CUPPET_STM_ONLY_COMPACTION
    else process.env.CUPPET_STM_ONLY_COMPACTION = previous
  }
})
