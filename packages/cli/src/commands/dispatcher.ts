import type { CuppetController } from '../controller.js'

export type CommandAction =
  | { type: 'platform' }
  | { type: 'login'; provider?: string }
  | { type: 'model'; role: 'primary' | 'secondary' }
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
        return { handled: true, message: JSON.stringify(await this.#controller.status(), null, 2) }
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

export const COMMANDS = [
  '/platform',
  '/login',
  '/model primary',
  '/model secondary',
  '/sessions',
  '/new',
  '/resume',
  '/status',
  '/memory',
  '/compact',
  '/steer',
  '/steer --interrupt',
  '/abort',
  '/undo',
  '/background pause',
  '/background resume',
  '/doctor',
  '/help',
]

const HELP = `Cuppet commands:
/platform                        Choose Anthropic, OpenAI, Google, or OpenCode
/login [provider]                 OpenCode-advertised key or OAuth login
/model primary|secondary         Select a live authenticated model
/sessions, /new, /resume [id]    Manage project sessions
/status, /memory                 Engine, usage, memory, graph, and queue status
/compact                         Compact OpenCode and durable memory
/steer [--interrupt] <text>      Steer at a safe boundary
/abort, /undo                    Abort or revert the latest change boundary
/memory remember [scope] k=v     Store an explicit preference
/memory forget <key>             Tombstone a memory
/memory clear <scope>            Clear with confirmation
/background pause|resume         Emergency background control
/doctor                          Verify runtime and provider health`

function splitArguments(value: string): string[] {
  const matches = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  return matches.map((item) => {
    const first = item[0]
    return (first === '"' || first === "'") && item.at(-1) === first ? item.slice(1, -1) : item
  })
}
