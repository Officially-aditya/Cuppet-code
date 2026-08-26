import type { PermissionRequest } from '../types.js'

/**
 * Bash is permission-gated by default. The controller may grant a one-time
 * approval for this intentionally small set of metadata-only workspace checks.
 */
export const BASH_PERMISSION = 'ask' as const

const MAX_COMMAND_LENGTH = 256
const PLAIN_COMMAND = /^[A-Za-z0-9._:=+-]+(?: [A-Za-z0-9._:=+-]+)*$/

const STATUS_FLAGS = new Set(['--short', '--branch', '--porcelain', '--porcelain=v1', '-s', '-b', '-sb'])
const LOG_FLAGS = new Set(['--oneline', '--no-decorate', '--no-show-signature', '--all', '-1'])
const BRANCH_FLAGS = new Set(['--show-current', '--all', '--verbose', '-a', '-v', '-vv'])
const LS_FILES_FLAGS = new Set(['--cached', '--modified', '--deleted', '--others', '--exclude-standard', '--stage'])
const LS_FLAGS = new Set(['-a', '-l', '-h', '-la', '-al', '-lah', '-lha', '--all', '--long', '--human-readable'])
const VERSION_COMMANDS = new Set([
  'git --version',
  'node --version',
  'npm --version',
  'pnpm --version',
  'yarn --version',
  'bun --version',
  'deno --version',
  'python --version',
  'python3 --version',
  'cargo --version',
  'rustc --version',
  'go version',
])

/**
 * Returns true only for simple, non-mutating commands that cannot contain a
 * path operand, shell syntax, expansion, redirection, command chaining, or
 * file contents. Everything else intentionally remains an explicit user
 * decision so Bash cannot bypass protected-file policy.
 */
export function isSafeAutoBashCommand(command: string): boolean {
  if (
    command.length === 0 ||
    command.length > MAX_COMMAND_LENGTH ||
    command.trim() !== command ||
    !PLAIN_COMMAND.test(command)
  ) return false

  if (VERSION_COMMANDS.has(command)) return true

  const tokens = command.split(' ')
  if (tokens.length === 1) return tokens[0] === 'pwd' || tokens[0] === 'ls'

  if (tokens[0] === 'ls') return tokens.slice(1).every((token) => LS_FLAGS.has(token))
  if (tokens[0] !== 'git') return false

  const [_, subcommand, ...arguments_] = tokens
  switch (subcommand) {
    case 'status':
      return arguments_.every((argument) => STATUS_FLAGS.has(argument))
    case 'log':
      return arguments_.includes('--oneline') && arguments_.every((argument) => LOG_FLAGS.has(argument))
    case 'branch':
      return arguments_.every((argument) => BRANCH_FLAGS.has(argument))
    case 'ls-files':
      return arguments_.every((argument) => LS_FILES_FLAGS.has(argument))
    case 'rev-parse':
      return arguments_.length === 1 && new Set([
        '--show-toplevel',
        '--is-inside-work-tree',
        '--git-dir',
      ]).has(arguments_[0]!)
    default:
      return false
  }
}

/**
 * A request is auto-approved only when it contains exactly one safe Bash
 * command. A one-time reply prevents OpenCode from saving a broad wildcard.
 */
export function shouldAutoApproveBash(request: PermissionRequest): boolean {
  return request.action === 'bash' && request.resources.length === 1 && isSafeAutoBashCommand(request.resources[0] ?? '')
}
