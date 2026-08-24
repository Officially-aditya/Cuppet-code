import assert from 'node:assert/strict'
import { test } from 'node:test'
import { transformCuppetModelContext, clearCuppetContextState, orchestratorModeEnabled } from '../src/context.js'

type TestMessage = {
  info: Record<string, unknown>
  parts: Array<{ type: string; text: string; synthetic?: boolean }>
}

function turn(index: number, text = `request ${index}`): TestMessage[] {
  return [
    {
      info: { id: `user-${index}`, role: 'user' },
      parts: [{ type: 'text', text }],
    },
    {
      info: { id: `assistant-${index}`, role: 'assistant', parentID: `user-${index}`, finish: 'stop' },
      parts: [{ type: 'text', text: `outcome ${index}` }],
    },
  ]
}

test('orchestrator mode flag reads the environment', async () => {
  process.env.CUPPET_ORCHESTRATOR = '1'
  assert.equal(orchestratorModeEnabled(), true)
  process.env.CUPPET_ORCHESTRATOR = '0'
  assert.equal(orchestratorModeEnabled(), false)
  delete process.env.CUPPET_ORCHESTRATOR
  assert.equal(orchestratorModeEnabled(), false)
})

test('orchestrator mode disables every automatic injection path', async () => {
  process.env.CUPPET_ORCHESTRATOR = '1'
  process.env.CUPPET_TASK_CONTEXT_AB = '1'
  process.env.CUPPET_CONTEXT_COMPILER_AB = '1'
  process.env.CUPPET_GRAPH_CAPSULE_ONLY = '1'
  process.env.CUPPET_STM_EVENT_CONTEXT = '1'
  clearCuppetContextState()
  let prepareCalls = 0
  const client = {
    async prepareContext() {
      prepareCalls += 1
      return { observation_complete: true, stm: [], ltm: [], graph: [], edges: [] }
    },
    async turnCompleted() {},
  }
  const output = { messages: [...turn(0), ...turn(1), { info: { id: 'user-2', role: 'user' }, parts: [{ type: 'text', text: 'Build the thing' }] }] }
  await transformCuppetModelContext(
    { sessionID: 'orch-session', agent: 'cuppet', phase: 'foreground', history: { estimatedTokens: 10, usableTokens: 100_000 } },
    output,
    client as never,
  )
  assert.equal(prepareCalls, 0, 'master retrieves explicitly; no automatic TST calls')
  assert.equal(output.messages.flatMap((message) => message.parts).filter((part) => part.synthetic === true).length, 0, 'no synthetic context parts')
  for (const key of ['CUPPET_TASK_CONTEXT_AB', 'CUPPET_CONTEXT_COMPILER_AB', 'CUPPET_GRAPH_CAPSULE_ONLY', 'CUPPET_STM_EVENT_CONTEXT']) delete process.env[key]
  delete process.env.CUPPET_ORCHESTRATOR
  clearCuppetContextState()
})

test('without orchestrator mode the same request still injects normally', async () => {
  delete process.env.CUPPET_ORCHESTRATOR
  for (const key of ['CUPPET_TASK_CONTEXT_AB', 'CUPPET_CONTEXT_COMPILER_AB', 'CUPPET_GRAPH_CAPSULE_ONLY', 'CUPPET_STM_EVENT_CONTEXT']) delete process.env[key]
  clearCuppetContextState()
  let prepareCalls = 0
  const client = {
    async prepareContext() {
      prepareCalls += 1
      return {
        observation_complete: true,
        stm: [{ key: 'k', value: 'v', provenance: 'model_candidate', evidence: [] }],
        ltm: [],
        graph: [],
        edges: [],
      }
    },
    async turnCompleted() {},
  }
  const output: { messages: TestMessage[] } = { messages: [{ info: { id: 'user-0', role: 'user' }, parts: [{ type: 'text', text: 'Build the thing' }] }] }
  await transformCuppetModelContext(
    { sessionID: 'normal-session', agent: 'cuppet', phase: 'foreground', history: { estimatedTokens: 1, usableTokens: 100_000 } },
    output,
    client as never,
  )
  assert.ok(prepareCalls > 0)
  assert.equal(output.messages.flatMap((message) => message.parts).some((part) => part.synthetic === true), true)
  clearCuppetContextState()
})
