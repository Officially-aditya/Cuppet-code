import type { ProviderAuth } from '../auth/providerAuth.js'
import type { StateMachineEngine } from '../engine/stateMachine.js'
import type { ShortTermMemory } from '../tst/stm.js'
import type { LongTermMemory } from '../tst/ltm.js'
import type { TreeCodeGraph } from '../tst/tree.js'

export type CommandResult = {
  handled: boolean
  message?: string
  action?: 'login_prompt' | 'model_prompt'
}

export class CommandDispatcher {
  private auth: ProviderAuth
  private engine: StateMachineEngine
  private stm: ShortTermMemory
  private ltm: LongTermMemory
  private tree: TreeCodeGraph

  constructor(
    auth: ProviderAuth,
    engine: StateMachineEngine,
    stm: ShortTermMemory,
    ltm: LongTermMemory,
    tree: TreeCodeGraph,
  ) {
    this.auth = auth
    this.engine = engine
    this.stm = stm
    this.ltm = ltm
    this.tree = tree
  }

  async dispatch(input: string): Promise<CommandResult> {
    const trimmed = input.trim()
    if (!trimmed.startsWith('/')) {
      return { handled: false }
    }

    const parts = trimmed.slice(1).split(/\s+/)
    const cmd = parts[0]?.toLowerCase()
    const arg = parts.slice(1).join(' ')

    switch (cmd) {
      case 'login': {
        if (!arg) {
          return { handled: true, action: 'login_prompt' }
        }
        const [provider, apiKey] = arg.split(/\s+/)
        if (provider === 'google' || provider === 'anthropic' || provider === 'openai') {
          this.auth.setProvider(provider, apiKey)
          return { handled: true, message: `Provider updated to ${provider}.` }
        }
        return { handled: true, message: `Unknown provider ${provider}. Use: google, anthropic, or openai.` }
      }

      case 'model': {
        if (!arg) {
          return { handled: true, action: 'model_prompt' }
        }
        const [primary, secondary] = arg.split(/\s+/)
        this.auth.setModels(primary!, secondary)
        return { handled: true, message: `Models updated. Primary: ${primary}${secondary ? `, Secondary: ${secondary}` : ''}` }
      }

      case 'status':
      case 'memory': {
        const state = this.engine.getState()
        const stmEntries = this.stm.getEntries()
        const ltmStats = this.ltm.getStats()
        const treeStats = this.tree.getStats()

        const output = `--- Cuppet TST System Status ---
Provider: ${this.auth.getStore().activeProvider}
Models: ${this.auth.getStore().primaryModel} (primary) | ${this.auth.getStore().secondaryModel} (secondary)
Token Usage: ${state.totalInputTokens + state.totalOutputTokens} (Input: ${state.totalInputTokens}, Output: ${state.totalOutputTokens})
STM Ring Buffer: ${stmEntries.length}/256 entries active
LTM Trie: ${ltmStats.nodeCount} nodes, ${ltmStats.payloadCount} payloads
AST Code Graph: ${treeStats.totalFiles} files, ${treeStats.totalRelationships} relationships`
        return { handled: true, message: output }
      }

      case 'compact': {
        this.stm.decay(0.5)
        return { handled: true, message: 'Forced compaction completed. Non-pinned STM decay applied.' }
      }

      case 'steer': {
        if (!arg) return { handled: true, message: 'Usage: /steer <instruction>' }
        this.engine.setGoal(arg)
        return { handled: true, message: `Active goal updated: ${arg}` }
      }

      case 'help': {
        return {
          handled: true,
          message: `Available Commands:
/login [provider] [key] - Configure provider (anthropic, openai, google)
/model [primary] [secondary] - Change models
/status or /memory - Show TST memory & token usage
/compact - Force memory compaction
/steer [goal] - Steer active goal
/help - Show this menu`,
        }
      }

      default:
        return { handled: true, message: `Unknown command /${cmd}. Type /help for available commands.` }
    }
  }
}
