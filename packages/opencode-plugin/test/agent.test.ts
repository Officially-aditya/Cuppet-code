import assert from 'node:assert/strict'
import { test } from 'node:test'
import CuppetPlugin, { foregroundPermissionRules } from '../src/index.js'

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
  assert.equal(agents.get('cuppet')?.steps, 64)
  assert.equal(agents.get('cuppet')?.hidden, false)
  assert.equal(agents.get('cuppet-background')?.steps, 1)
  assert.equal(agents.get('cuppet-background')?.hidden, true)
  assert.deepEqual(agents.get('cuppet-background')?.permissions, [
    { action: '*', resource: '*', effect: 'deny' },
  ])
})
