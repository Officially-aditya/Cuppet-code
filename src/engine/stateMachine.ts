import type { ShortTermMemory } from '../tst/stm.js'
import type { LongTermMemory } from '../tst/ltm.js'
import type { TreeCodeGraph } from '../tst/tree.js'
import type { ModelRouter } from '../providers/router.js'

export type EngineState = {
  activeGoal?: string
  lastAction?: string
  totalInputTokens: number
  totalOutputTokens: number
  turnsCount: number
}

export class StateMachineEngine {
  private stm: ShortTermMemory
  private ltm: LongTermMemory
  private tree: TreeCodeGraph
  private router: ModelRouter
  private state: EngineState = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    turnsCount: 0,
  }

  constructor(stm: ShortTermMemory, ltm: LongTermMemory, tree: TreeCodeGraph, router: ModelRouter) {
    this.stm = stm
    this.ltm = ltm
    this.tree = tree
    this.router = router
  }

  getState(): EngineState {
    return { ...this.state }
  }

  setGoal(goal: string): void {
    this.state.activeGoal = goal
    this.stm.add({
      key: 'goal',
      observation: goal,
      confidence: 1.0,
      relevance: 1.0,
      pinned: true,
    })
  }

  async executeTurn(userInput: string, onStep?: (msg: string) => void): Promise<string> {
    if (!this.state.activeGoal) {
      this.setGoal(userInput)
    }

    onStep?.('Pre-fetching AST code nodes & LTM facts...')
    const stmContext = this.stm.recall(userInput)
    const ltmFacts = this.ltm.query(userInput, 6)
    const treeNodes = this.tree.search(userInput, 6)

    const stmBlock = stmContext.text ? `\nSTM Working Memory:\n${stmContext.text}` : ''
    const ltmBlock = ltmFacts.length > 0 ? `\nVerified Project Facts (LTM):\n${ltmFacts.map(f => `- ${f.statement}`).join('\n')}` : ''
    const treeBlock = treeNodes.length > 0 ? `\nAST Code Nodes:\n${treeNodes.map(n => `- File: ${n.path} | Summary: ${n.summary}`).join('\n')}` : ''

    const systemPrompt = `You are Cuppet, an ultra-efficient TST Terminal Coding Agent.
You operate as a State Machine. Never rely on past chat logs; use the structured memory provided below.
Be concise, technical, and precise.

Goal: ${this.state.activeGoal}
${stmBlock}
${ltmBlock}
${treeBlock}`

    onStep?.('Calling model...')
    const response = await this.router.generate({
      systemPrompt,
      userPrompt: userInput,
    })

    this.state.totalInputTokens += response.inputTokens
    this.state.totalOutputTokens += response.outputTokens
    this.state.turnsCount += 1
    this.state.lastAction = response.text

    // Digest learnings into STM
    this.stm.add({
      key: `turn_${this.state.turnsCount}`,
      observation: `User: ${userInput.slice(0, 60)} -> Assistant: ${response.text.slice(0, 100)}`,
      confidence: 0.9,
      relevance: 0.8,
      pinned: false,
    })
    this.stm.decay()

    return response.text
  }
}
