import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
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
const WORKSPACE_ACTIONS = new Set(['read', 'edit', 'write'])
const UNSAFE_RESOURCE_CHARACTERS = /[\\*?\[\]{}]/

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

/**
 * Auto mode may approve ordinary reads and mutations inside the active
 * workspace. Sensitive files, path patterns, symlink escapes, and every
 * external location remain explicit permission requests.
 */
export async function shouldAutoApproveWorkspacePermission(
  request: PermissionRequest,
  workspaceRoot: string,
): Promise<boolean> {
  if (!WORKSPACE_ACTIONS.has(request.action) || request.resources.length === 0) return false
  return (await Promise.all(request.resources.map((resource) => isSafeWorkspaceResource(resource, workspaceRoot))))
    .every(Boolean)
}

async function isSafeWorkspaceResource(resource: string, workspaceRoot: string): Promise<boolean> {
  if (
    !resource ||
    resource.trim() !== resource ||
    resource.includes('\0') ||
    resource.startsWith('~') ||
    resource.startsWith('file:') ||
    UNSAFE_RESOURCE_CHARACTERS.test(resource)
  ) return false

  const root = await realpath(workspaceRoot).catch(() => resolve(workspaceRoot))
  const candidate = isAbsolute(resource) ? resolve(resource) : resolve(root, resource)
  const workspacePath = relative(root, candidate)
  if (!workspacePath || !isInside(root, candidate) || isSensitivePath(workspacePath)) return false
  return nearestExistingAncestorIsInside(candidate, root)
}

async function nearestExistingAncestorIsInside(candidate: string, root: string): Promise<boolean> {
  let ancestor = candidate
  for (;;) {
    try {
      return isAtOrInside(root, await realpath(ancestor))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return false
      const parent = dirname(ancestor)
      if (parent === ancestor) return false
      ancestor = parent
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  return relative(root, candidate) !== '' && isAtOrInside(root, candidate)
}

function isAtOrInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function isSensitivePath(path: string): boolean {
  const parts = path.split(sep).map((part) => part.toLowerCase())
  return parts.some((part) =>
    part === '.claude.json' ||
    part === '.env' ||
    part.startsWith('.env.') ||
    part.includes('credentials') ||
    part.endsWith('.pem') ||
    part.endsWith('.key') ||
    part === 'ltm-trie.json',
  )
}
