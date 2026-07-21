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
