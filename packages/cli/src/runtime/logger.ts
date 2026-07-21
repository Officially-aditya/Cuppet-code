import { appendFile, chmod, mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_LOG_BYTES = 1_000_000

export class RedactedLogger {
  readonly #directory: string
  readonly #path: string

  constructor(directory: string) {
    this.#directory = directory
    this.#path = join(directory, 'cuppet.log')
  }

  async write(level: 'info' | 'warn' | 'error', message: string): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    await this.#rotate()
    const line = JSON.stringify({ time: new Date().toISOString(), level, message: redact(message) })
    await appendFile(this.#path, `${line}\n`, { mode: 0o600 })
    await chmod(this.#path, 0o600)
  }

  async #rotate(): Promise<void> {
    try {
      if ((await stat(this.#path)).size < MAX_LOG_BYTES) return
      await rename(this.#path, join(this.#directory, 'cuppet.log.1'))
      await writeFile(this.#path, '', { mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

export function redact(value: string): string {
  return value
    .replace(/\b(?:sk-|ghp_|glpat-|xoxb-|AIza)[A-Za-z0-9._-]{12,}\b/g, '[REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
    .replace(/(authorization|api[_-]?key|password|token)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
}
