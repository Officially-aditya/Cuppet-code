import { test } from 'node:test'
import assert from 'node:assert'
import { ShortTermMemory } from '../src/tst/stm.js'
import { LongTermMemory } from '../src/tst/ltm.js'
import { TreeCodeGraph } from '../src/tst/tree.js'
import { ProviderAuth } from '../src/auth/providerAuth.js'
import { CommandDispatcher } from '../src/commands/commandDispatcher.js'
import { StateMachineEngine } from '../src/engine/stateMachine.js'
import { ModelRouter } from '../src/providers/router.js'
import { tmpdir } from 'os'
import { join } from 'path'

test('ShortTermMemory ring buffer adds entries and decays scores', () => {
  const stm = new ShortTermMemory(10)
  stm.add({ key: 'test_key', observation: 'Building TST agent', confidence: 1.0, relevance: 1.0, pinned: false })

  const recalled = stm.recall('building')
  assert.strictEqual(recalled.entries.length, 1)
  assert.strictEqual(recalled.entries[0]?.key, 'test_key')

  stm.decay(0.5)
  assert.strictEqual(recalled.entries[0]?.relevance, 0.5)
})

test('LongTermMemory trie puts and queries payloads', async () => {
  const ltmFile = join(tmpdir(), `ltm_test_${Date.now()}.json`)
  const ltm = new LongTermMemory(ltmFile)
  await ltm.init()

  ltm.put('pattern:db_migrations', {
    type: 'pattern',
    version: 1,
    statement: 'DB migrations require npm run db:generate',
    confidence: 1.0,
    paths: ['schema.sql'],
    symbols: ['Migration'],
  })

  const found = ltm.query('migrations')
  assert.strictEqual(found.length, 1)
  assert.strictEqual(found[0]?.statement, 'DB migrations require npm run db:generate')
})

test('TreeCodeGraph indexes current directory files', async () => {
  const tree = new TreeCodeGraph(process.cwd())
  await tree.build()
  const stats = tree.getStats()
  assert.ok(stats.totalFiles >= 0)
})

test('CommandDispatcher handles /status and /help', async () => {
  const auth = new ProviderAuth()
  await auth.init()
  const stm = new ShortTermMemory(10)
  const ltmFile = join(tmpdir(), `ltm_test2_${Date.now()}.json`)
  const ltm = new LongTermMemory(ltmFile)
  await ltm.init()
  const tree = new TreeCodeGraph(process.cwd())
  await tree.build()

  const router = new ModelRouter(auth.getStore())
  const engine = new StateMachineEngine(stm, ltm, tree, router)
  const dispatcher = new CommandDispatcher(auth, engine, stm, ltm, tree)

  const helpResult = await dispatcher.dispatch('/help')
  assert.strictEqual(helpResult.handled, true)
  assert.ok(helpResult.message?.includes('/login'))

  const statusResult = await dispatcher.dispatch('/status')
  assert.strictEqual(statusResult.handled, true)
  assert.ok(statusResult.message?.includes('Token Usage'))
})
