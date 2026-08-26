import assert from 'node:assert/strict'
import { test } from 'node:test'
import CuppetPlugin, { CuppetMemoryPlugin, foregroundPermissionRules, graphToolOutput } from '../src/index.js'

test('Promise plugin registers both Cuppet agents and reloads the pinned v2 domain', async () => {
  const agents = new Map<string, Record<string, unknown>>()
  let defaultAgent: string | undefined
  let reloads = 0
  const context = {
    agent: {
      async transform(update: (draft: unknown) => Promise<void> | void) {
        await update({
          default(id: string | undefined) { defaultAgent = id },
          update(id: string, mutate: (agent: Record<string, unknown>) => void) {
            const agent: Record<string, unknown> = {
              mode: 'all',
              hidden: false,
              permissions: [],
            }
            mutate(agent)
            agents.set(id, agent)
          },
        })
        return { async dispose() {} }
      },
      async reload() { reloads += 1 },
    },
    catalog: {
      async transform() { return { async dispose() {} } },
      async reload() {},
    },
  }

  await CuppetPlugin.setup(context as never)

  assert.equal(defaultAgent, 'cuppet')
  assert.equal(reloads, 1, 'OpenCode 1.18.4 requires an explicit reload after an async external transform')
  assert.deepEqual(agents.get('cuppet')?.permissions, foregroundPermissionRules())
  const cuppetPermissions = agents.get('cuppet')?.permissions as Array<{ action: string; effect: string }>
  assert.ok(cuppetPermissions.some((rule) => rule.action === 'bash' && rule.effect === 'ask'))
  assert.equal(agents.get('cuppet')?.steps, 128)
  assert.equal(agents.get('cuppet')?.hidden, false)
  assert.equal(agents.get('build')?.steps, 128)
  assert.deepEqual(agents.get('build')?.permissions, foregroundPermissionRules())
  assert.equal(agents.get('plan')?.steps, 128)
  assert.equal(agents.get('cuppet-background')?.steps, 1)
  assert.equal(agents.get('cuppet-background')?.hidden, true)
  assert.deepEqual(agents.get('cuppet-background')?.permissions, [
    { action: '*', resource: '*', effect: 'deny' },
  ])
})

test('Promise plugin exposes graph navigation tools alongside memory search', async () => {
  const plugin = await CuppetMemoryPlugin()
  assert.deepEqual(Object.keys(plugin.tool), [
    'cuppet_plan',
    'cuppet_memory_search',
    'cuppet_workspace_info',
    'cuppet_graph_tree',
    'cuppet_graph_search',
    'cuppet_graph_trace',
  ])
})

test('compact graph tool rendering is untrusted, capped, and free of rich graph JSON', () => {
  const locate = graphToolOutput('Cuppet graph locate', 'locate', {
    query: 'needle',
    truncated: true,
    matches: Array.from({ length: 12 }, (_, index) => ({
      path: `src/very-long-${index}.ts`,
      symbol: `needle${index}`,
      kind: 'function_declaration',
      line: index + 1,
      column: 1,
      content_hash: 'must-not-render',
    })),
  }, 240)
  assert.match(locate.output, /^UNTRUSTED CUPPET CODE GRAPH RESULTS/)
  assert.match(locate.output, /narrow the query or scope/i)
  assert.doesNotMatch(locate.output, /content_hash|\{|\"matches\"/)
  assert.ok(locate.output.length <= 240)
  assert.equal(locate.metadata.truncated, true)
  assert.equal(locate.metadata.cacheHit, false)
  assert.equal(locate.metadata.outputBytes, Buffer.byteLength(locate.output))

  const trace = graphToolOutput('Cuppet graph trace', 'trace', {
    query: 'handler',
    direction: 'callees',
    depth: 2,
    edges: [{
      from: { path: 'src/api.ts', symbol: 'handler', kind: 'function', line: 4, column: 1 },
      to: { path: 'src/store.ts', symbol: 'addTask', kind: 'function', line: 8, column: 1 },
      kind: 'call',
      span: { start_byte: 1 },
    }],
  }, 2_400)
  assert.match(trace.output, /src\/api\.ts:4:1 function handler --call-->/)
  assert.doesNotMatch(trace.output, /start_byte|span/)
})
