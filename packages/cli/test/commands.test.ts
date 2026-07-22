import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandDispatcher, COMMANDS } from '../src/commands/dispatcher.js'
import type { CuppetController } from '../src/controller.js'

test('/platform opens the platform selector', async () => {
  const dispatcher = new CommandDispatcher({} as CuppetController)
  assert.deepEqual(await dispatcher.dispatch('/platform'), {
    handled: true,
    action: { type: 'platform' },
  })
  assert.ok(COMMANDS.includes('/platform'))
})

test('/effort opens the primary effort selector by default', async () => {
  const dispatcher = new CommandDispatcher({} as CuppetController)
  assert.deepEqual(await dispatcher.dispatch('/effort'), {
    handled: true,
    action: { type: 'effort', role: 'primary' },
  })
  assert.deepEqual(await dispatcher.dispatch('/effort secondary'), {
    handled: true,
    action: { type: 'effort', role: 'secondary' },
  })
  assert.ok(COMMANDS.includes('/effort'))
})

test('/effort sets an advertised level directly', async () => {
  const calls: Array<{ role: string; effort: string }> = []
  const controller = {
    async selectEffort(role: string, effort: string) {
      calls.push({ role, effort })
      return effort.toLowerCase()
    },
  } as unknown as CuppetController
  const dispatcher = new CommandDispatcher(controller)

  assert.deepEqual(await dispatcher.dispatch('/effort secondary HIGH'), {
    handled: true,
    message: 'Secondary effort set to high.',
  })
  assert.deepEqual(calls, [{ role: 'secondary', effort: 'HIGH' }])
  assert.deepEqual(await dispatcher.dispatch('/effort primary high extra'), {
    handled: true,
    message: 'Usage: /effort [primary|secondary] [level]',
  })
})
