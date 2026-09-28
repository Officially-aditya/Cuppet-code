import { createConnection, type Socket } from 'node:net'

/**
 * Parse a Cuppet IPC endpoint. Mirrors `packages/cli/src/runtime/ipc.ts`:
 * Unix/macOS/Linux use filesystem socket paths, Windows control endpoints
 * use named pipes (`\\.\pipe\…`), and the Windows TST daemon uses
 * loopback TCP (`127.0.0.1:<port>`). This module is intentionally duplicated
 * so the bundled plugin stays dependency-free.
 */
export function parseIpcEndpoint(endpoint: string): { kind: 'tcp'; host: string; port: number } | { kind: 'path'; path: string } {
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
