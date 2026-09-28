import { createConnection, createServer, type Socket } from 'node:net'
import { chmod, mkdir } from 'node:fs/promises'

/** True on Windows, where Unix-domain sockets and POSIX modes are unavailable. */
export const isWindows = process.platform === 'win32'

export type ParsedIpcEndpoint =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'path'; path: string }

/**
 * Parse a Cuppet IPC endpoint. Unix/macOS/Linux use filesystem socket paths
 * (e.g. `<runtime>/control.sock`); Windows control endpoints use named pipes
 * (`\\.\pipe\cuppet-…`) and the Windows TST daemon uses loopback TCP
 * (`127.0.0.1:<port>`). Anything that is not an explicit loopback TCP
 * endpoint is treated as a pipe/socket path and handed to `net` directly,
 * which keeps macOS/Linux behavior byte-for-byte identical.
 */
export function parseIpcEndpoint(endpoint: string): ParsedIpcEndpoint {
  const trimmed = endpoint.trim()
  const tcp = /^(127\.0\.0\.1|localhost):(\d{1,5})$/.exec(trimmed)
  if (tcp) {
    const host = tcp[1]
    const portText = tcp[2]
    if (host && portText) {
      const port = Number(portText)
      if (Number.isInteger(port) && port > 0 && port <= 65_535) return { kind: 'tcp', host, port }
    }
  }
  return { kind: 'path', path: endpoint }
}

export function isTcpEndpoint(endpoint: string): boolean {
  return parseIpcEndpoint(endpoint).kind === 'tcp'
}

export function isPipeEndpoint(endpoint: string): boolean {
  return endpoint.startsWith('\\\\.\\pipe\\') || endpoint.startsWith('\\\\?\\pipe\\')
}

/** Connect to either a Unix socket / Windows named pipe path or loopback TCP. */
export function connectIpc(endpoint: string): Promise<Socket> {
  const parsed = parseIpcEndpoint(endpoint)
  return new Promise((resolve, reject) => {
    const socket = parsed.kind === 'tcp'
      ? createConnection({ host: parsed.host, port: parsed.port })
      : createConnection(parsed.path)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

/** Allocate a free loopback TCP port (Windows TST transport). */
export async function pickLoopbackPort(host = '127.0.0.1'): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, host, () => resolve())
  })
  const address = probe.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  if (!port) throw new Error('unable to allocate a loopback TCP port')
  return port
}

/** Build a Windows named-pipe endpoint for a launch-scoped service. */
export function pipeEndpoint(name: string): string {
  return `\\\\.\\pipe\\${name}`
}

/** chmod is a no-op on Windows (only the read-only attribute exists). */
export async function chmodPrivate(path: string, mode: number): Promise<void> {
  if (isWindows) return
  await chmod(path, mode)
}

/** mkdir -p with a best-effort private mode (mode is ignored on Windows). */
export async function mkdirPrivate(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmodPrivate(directory, 0o700)
}
