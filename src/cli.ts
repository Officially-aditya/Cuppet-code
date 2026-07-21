import React from 'react'
import { render } from 'ink'
import { join } from 'path'
import { homedir } from 'os'
import { ProviderAuth } from './auth/providerAuth.js'
import { ShortTermMemory } from './tst/stm.js'
import { LongTermMemory } from './tst/ltm.js'
import { TreeCodeGraph } from './tst/tree.js'
import { ModelRouter } from './providers/router.js'
import { StateMachineEngine } from './engine/stateMachine.js'
import { CommandDispatcher } from './commands/commandDispatcher.js'
import { TerminalApp } from './ui/TerminalApp.js'

async function main() {
  const cwd = process.cwd()

  // 1. Initialize Auth
  const auth = new ProviderAuth()
  const creds = await auth.init()

  // 2. Initialize Memory Systems
  const stm = new ShortTermMemory(256)
  const ltmFile = join(homedir(), '.cuppet', 'ltm-trie.json')
  const ltm = new LongTermMemory(ltmFile)
  await ltm.init()

  // 3. Initialize Code Graph
  const tree = new TreeCodeGraph(cwd)
  await tree.build()
  tree.startWatcher()

  // 4. Initialize Providers & Engine
  const router = new ModelRouter(creds)
  const engine = new StateMachineEngine(stm, ltm, tree, router)
  const dispatcher = new CommandDispatcher(auth, engine, stm, ltm, tree)

  // 5. Render Ink UI
  const app = render(
    React.createElement(TerminalApp, {
      auth,
      engine,
      dispatcher,
      stm,
    })
  )

  await app.waitUntilExit()
  tree.stopWatcher()
}

main().catch(err => {
  console.error('Fatal CLI Error:', err)
  process.exit(1)
})
