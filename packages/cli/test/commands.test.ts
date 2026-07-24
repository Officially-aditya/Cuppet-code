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

test('/plan command toggles plan mode', async () => {
  let planState = false
  const controller = {
    togglePlanMode(enable?: boolean) {
      planState = enable ?? !planState
      return planState
    },
  } as unknown as CuppetController
  const dispatcher = new CommandDispatcher(controller)

  assert.deepEqual(await dispatcher.dispatch('/plan'), {
    handled: true,
    message: 'Plan mode enabled (submitting full code graph for requirement extraction & goal establishment).',
  })
  assert.equal(planState, true)

  assert.deepEqual(await dispatcher.dispatch('/plan off'), {
    handled: true,
    message: 'Plan mode disabled.',
  })
  assert.equal(planState, false)

  assert.deepEqual(await dispatcher.dispatch('/plan on'), {
    handled: true,
    message: 'Plan mode enabled (submitting full code graph for requirement extraction & goal establishment).',
  })
  assert.equal(planState, true)

  assert.ok(COMMANDS.includes('/plan'))
  assert.ok(COMMANDS.includes('/plan on'))
  assert.ok(COMMANDS.includes('/plan off'))
})
