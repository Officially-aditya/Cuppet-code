import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ORCHESTRATOR_ENV_FLAG, ORCHESTRATOR_INSTRUCTION, orchestratorWorkerAgentConfig } from '../src/opencode/server.js'

test('orchestrator worker agent pins the secondary model with execution budget', () => {
  const config = orchestratorWorkerAgentConfig({ providerID: 'openai', modelID: 'gpt-5.6-luna', variant: 'low' })
  assert.equal(config.model, 'openai/gpt-5.6-luna')
  assert.equal(config.variant, 'low')
  assert.equal(config.mode, 'subagent')
  assert.equal(config.steps, 96)
  assert.equal(config.maxSteps, 96)
  assert.match(config.description, /worker/i)

  const bare = orchestratorWorkerAgentConfig(undefined)
  assert.equal(bare.model, undefined, 'worker without a secondary model inherits the session default')
})

test('master instruction assigns context work to the master and code to the worker', () => {
  assert.match(ORCHESTRATOR_INSTRUCTION, /worker/)
  assert.match(ORCHESTRATOR_INSTRUCTION, /cuppet_memory_search|cuppet_graph_search/)
  assert.match(ORCHESTRATOR_INSTRUCTION, /task tool/i)
  assert.equal(ORCHESTRATOR_ENV_FLAG, 'CUPPET_ORCHESTRATOR')
})
