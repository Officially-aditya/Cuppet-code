import type { CuppetController } from '../controller.js'

export type CommandAction =
  | { type: 'platform' }
  | { type: 'status' }
  | { type: 'login'; provider?: string }
  | { type: 'model'; role: 'primary' | 'secondary' }
  | { type: 'effort'; role: 'primary' | 'secondary' }
  | { type: 'resume' }
  | { type: 'confirm-clear'; scope: 'session' | 'project' | 'global' }

export type CommandResult = {
  handled: boolean
  message?: string
  action?: CommandAction
}

export class CommandDispatcher {
  readonly #controller: CuppetController

  constructor(controller: CuppetController) {
    this.#controller = controller
  }

  async dispatch(input: string): Promise<CommandResult> {
    const trimmed = input.trim()
    if (!trimmed.startsWith('/')) return { handled: false }
    const [command = '', ...arguments_] = splitArguments(trimmed.slice(1))
    const name = command.toLowerCase()

    switch (name) {
      case 'platform':
        return { handled: true, action: { type: 'platform' } }
      case 'login':
        return {
          handled: true,
          action: { type: 'login', ...(arguments_[0] ? { provider: arguments_[0] } : {}) },
        }
      case 'model': {
        const role = arguments_[0]
        if (role !== 'primary' && role !== 'secondary') {
          return { handled: true, message: 'Usage: /model primary|secondary' }
        }
        return { handled: true, action: { type: 'model', role } }
      }
      case 'effort': {
        const possibleRole = arguments_[0]?.toLowerCase()
        const role = possibleRole === 'primary' || possibleRole === 'secondary' ? possibleRole : 'primary'
        const effort = role === possibleRole ? arguments_[1] : arguments_[0]
        const expectedArguments = role === possibleRole ? 2 : 1
        if (arguments_.length > expectedArguments) {
          return { handled: true, message: 'Usage: /effort [primary|secondary] [level]' }
        }
        if (!effort) return { handled: true, action: { type: 'effort', role } }
        const selected = await this.#controller.selectEffort(role, effort)
        return { handled: true, message: `${capitalize(role)} effort set to ${selected}.` }
      }
      case 'sessions':
        return { handled: true, action: { type: 'resume' } }
      case 'resume':
        if (!arguments_[0]) return { handled: true, action: { type: 'resume' } }
        return {
          handled: true,
          message: `Resumed session ${(await this.#controller.resume(arguments_[0])).title}.`,
        }
      case 'new':
        return {
          handled: true,
          message: `Created session ${(await this.#controller.newSession()).id}.`,
        }
      case 'status':
        return { handled: true, action: { type: 'status' } }
      case 'plan': {
        const option = arguments_[0]?.toLowerCase()
        if (option && option !== 'on' && option !== 'off' && option !== 'toggle') {
          return { handled: true, message: 'Usage: /plan [on|off]' }
        }
        const state = option === 'on' ? true : option === 'off' ? false : undefined
        const active = this.#controller.togglePlanMode(state)
        return {
          handled: true,
          message: active
            ? 'Plan mode enabled (submitting full code graph for requirement extraction & goal establishment).'
            : 'Plan mode disabled.',
        }
      }
      case 'memory':
        return this.#memory(arguments_)
      case 'compact':
        await this.#controller.compact()
        return { handled: true, message: 'Conversation, eligible memory, snapshots, and WAL compacted.' }
      case 'steer': {
        const interrupt = arguments_[0] === '--interrupt'
        const instruction = (interrupt ? arguments_.slice(1) : arguments_).join(' ')
        if (!instruction) return { handled: true, message: 'Usage: /steer [--interrupt] <instruction>' }
        return { handled: true, message: await this.#controller.steer(instruction, interrupt) }
      }
      case 'abort':
        await this.#controller.abort()
        return { handled: true, message: 'Active session aborted.' }
      case 'undo':
        await this.#controller.undo()
        return { handled: true, message: 'Latest OpenCode change boundary reverted.' }
      case 'background': {
        const operation = arguments_[0]
        if (operation !== 'pause' && operation !== 'resume') {
          return { handled: true, message: 'Usage: /background pause|resume' }
        }
        await this.#controller.setBackgroundPaused(operation === 'pause')
        return { handled: true, message: `Background enrichment ${operation === 'pause' ? 'paused' : 'resumed'}.` }
      }
      case 'doctor':
        return { handled: true, message: JSON.stringify(await this.#controller.doctor(), null, 2) }
      case 'help':
        return { handled: true, message: HELP }
      case '':
        return { handled: true }
      default:
        return { handled: true, message: `Unknown command /${name}. Type /help for commands.` }
    }
  }

  async #memory(arguments_: string[]): Promise<CommandResult> {
    const operation = arguments_[0]
    if (!operation) return { handled: true, message: JSON.stringify(await this.#controller.status(), null, 2) }
    if (operation === 'remember') {
      const possibleScope = arguments_[1]
      const scope = possibleScope === 'global' ? 'global' : 'project'
      const expression = arguments_.slice(possibleScope === 'global' || possibleScope === 'project' ? 2 : 1).join(' ')
      const separator = expression.indexOf('=')
      if (separator < 1 || separator === expression.length - 1) {
        return {
          handled: true,
          message: 'Usage: /memory remember [project|global] <key>=<preference>',
        }
      }
      const key = expression.slice(0, separator).trim()
      const value = expression.slice(separator + 1).trim()
      const id = await this.#controller.remember(key, value, scope)
      return { handled: true, message: `Remembered ${key} (${id}, ${scope}).` }
    }
    if (operation === 'forget') {
      const key = arguments_.slice(1).join(' ').trim()
      if (!key) return { handled: true, message: 'Usage: /memory forget <key>' }
      return { handled: true, message: `Removed ${await this.#controller.forget(key)} matching record(s).` }
    }
    if (operation === 'clear') {
      const scope = arguments_[1]
      if (scope !== 'session' && scope !== 'project' && scope !== 'global') {
        return { handled: true, message: 'Usage: /memory clear session|project|global' }
      }
      return { handled: true, action: { type: 'confirm-clear', scope } }
    }
    return { handled: true, message: 'Usage: /memory remember|forget|clear' }
  }
}

export type CommandCompletion = {
  command: string
  description: string
}

/**
 * The one canonical list of interactive commands. Keep the command text here
 * so the completion menu and `/help` can never drift apart.
 */
export const COMMAND_COMPLETIONS: readonly CommandCompletion[] = [
  { command: '/platform', description: 'Choose a provider platform' },
  { command: '/login', description: 'Connect a provider with a key or OAuth' },
  { command: '/model primary', description: 'Select the primary model' },
  { command: '/model secondary', description: 'Select the secondary model' },
  { command: '/effort', description: 'Choose primary model effort' },
  { command: '/effort primary', description: 'Choose primary model effort' },
  { command: '/effort secondary', description: 'Choose secondary model effort' },
  { command: '/sessions', description: 'Resume a project session' },
  { command: '/new', description: 'Start a new session' },
  { command: '/resume', description: 'Resume a session by ID' },
  { command: '/status', description: 'Show session and runtime status' },
  { command: '/plan', description: 'Toggle plan mode' },
  { command: '/plan on', description: 'Enable plan mode' },
  { command: '/plan off', description: 'Disable plan mode' },
  { command: '/memory', description: 'Show memory status' },
  { command: '/compact', description: 'Compact conversation and memory' },
  { command: '/steer', description: 'Steer at the next safe boundary' },
  { command: '/steer --interrupt', description: 'Interrupt and steer immediately' },
  { command: '/abort', description: 'Abort the active session' },
  { command: '/undo', description: 'Revert the latest change boundary' },
  { command: '/background pause', description: 'Pause background enrichment' },
  { command: '/background resume', description: 'Resume background enrichment' },
  { command: '/doctor', description: 'Check runtime and provider health' },
  { command: '/help', description: 'List available commands' },
]

// Retained as a lightweight compatibility export for callers that only need
// command text. New UI code should use COMMAND_COMPLETIONS.
export const COMMANDS = COMMAND_COMPLETIONS.map(({ command }) => command)

const HELP = [
  'Cuppet commands:',
  ...COMMAND_COMPLETIONS.map(({ command, description }) => `${command.padEnd(30)} ${description}`),
].join('\n')

function splitArguments(value: string): string[] {
  const matches = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  return matches.map((item) => {
    const first = item[0]
    return (first === '"' || first === "'") && item.at(-1) === first ? item.slice(1, -1) : item
  })
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`
}
