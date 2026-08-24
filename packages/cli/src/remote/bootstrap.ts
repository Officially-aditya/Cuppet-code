import type { CuppetController } from '../controller.js'
import { RemoteBridge } from './bridge.js'
import { WebSocketTransport } from './connection.js'
import { ensureHostIdentity, type HostIdentity } from './identity.js'
import {
  authenticateDevice,
  claimPairingInvite,
  createPairingInvite,
  listPairedDevices,
  relayWebSocketUrl,
  type PairingInvite,
} from './pairing.js'
import { verifyRemoteToken } from './token.js'

export type RemoteControlOptions = {
  controller: CuppetController
  /** Durable per-machine state directory (host identity + device registry). */
  remoteDir: string
  relayUrl?: string
  hostSecret?: string
  /** Same value as Sydney REMOTE_TOKEN_SECRET for managed mobile tokens. */
  remoteTokenSecret?: string
  /** Fresh pairing invite per session by default; disable for long-lived hosts. */
  createInvite?: boolean
  write?: (line: string) => void
}

export type RemoteControlSession = {
  identity: HostIdentity
  invite: Awaited<ReturnType<typeof createPairingInvite>> | undefined
  bridge: RemoteBridge | undefined
  stop(): void
}

/**
 * Shared startup for interactive (`cuppet --remote-control`) and headless
 * (`cuppet remote-control`) host modes: loads the durable host identity,
 * dials the relay outbound, publishes a single-use pairing invite with a
 * scannable QR, and returns a handle the CLI tears down at shutdown.
 */
export async function startRemoteControl(options: RemoteControlOptions): Promise<RemoteControlSession> {
  const write = options.write ?? ((line: string) => process.stdout.write(line))
  const identity = await ensureHostIdentity(options.remoteDir)
  write(`Remote control\n  host: ${identity.hostId} (${identity.deviceName})\n`)
  for (const device of await listPairedDevices(options.remoteDir)) {
    write(`  paired: ${device.name} [${device.deviceId}] ${device.scopes.join(',')}\n`)
  }

  let bridge: RemoteBridge | undefined
  if (options.relayUrl) {
    const params = new URLSearchParams({
      role: 'host',
      hostId: identity.hostId,
      secret: options.hostSecret ?? '',
    })
    const transport = new WebSocketTransport(`${relayWebSocketUrl(options.relayUrl)}?${params}`)
    bridge = new RemoteBridge({
      controller: options.controller,
      hostId: identity.hostId,
      transport,
      authenticateDevice: async (deviceId, secret) => {
        const local = await authenticateDevice(options.remoteDir, deviceId, secret)
        if (local) return local
        if (!options.remoteTokenSecret) return undefined
        return verifyRemoteToken(secret, options.remoteTokenSecret, identity.hostId, deviceId)
      },
      claimPairingInvite: (code, deviceName) => claimPairingInvite(options.remoteDir, code, deviceName),
      buildAttachSnapshot: async () => ({
        snapshot: options.controller.snapshot,
        permissions: await options.controller.listPendingPermissions().catch(() => []),
        questions: await options.controller.listPendingQuestions().catch(() => []),
      }),
    })
    bridge.start()
    write(`  relay: dialing ${options.relayUrl}\n`)
  } else {
    write('  set CUPPET_RELAY_URL or pass --relay-url <wss://…> to connect the bridge\n')
  }

  let invite: PairingInvite & { url: string | undefined } | undefined
  if (options.createInvite ?? true) {
    invite = await createPairingInvite(options.remoteDir, {
      ...(options.relayUrl ? { relayUrl: options.relayUrl } : {}),
      hostId: identity.hostId,
    })
    write(`  pair a device — code ${invite.code} expires ${new Date(invite.expiresAt).toISOString()}\n`)
    if (invite.url) {
      write(`  ${invite.url}\n`)
      const qr = await renderTerminalQr(invite.url)
      if (qr) write(`${qr}\n`)
    }
  }

  return {
    identity,
    invite,
    bridge,
    stop(): void {
      bridge?.stop()
    },
  }
}

/** Best-effort terminal QR; empty string when the renderer is unavailable. */
export async function renderTerminalQr(text: string): Promise<string> {
  try {
    const qrcode = await import('qrcode')
    return await qrcode.toString(text, { type: 'terminal', small: true })
  } catch {
    return ''
  }
}
