import type { CuppetController } from '../controller.js'
import { RemoteBridge } from './bridge.js'
import { WebSocketTransport } from './connection.js'
import { ensureHostIdentity, setRemoteTokenPublicKey, type HostIdentity } from './identity.js'
import {
  authenticateDevice,
  claimPairingInvite,
  createPairingInvite,
  listPairedDevices,
  relayWebSocketUrl,
  type PairingInvite,
} from './pairing.js'
import { registerHost } from './enroll.js'
import { verifyRemoteToken } from './token.js'
import { runRemoteSetup, type RemoteSetupPrompt } from './setup.js'
import { renderTerminalQr } from './qr.js'
import { DEFAULT_CUPPET_API_BASE } from '../constants.js'

export type RemoteControlOptions = {
  controller: CuppetController
  /** Durable per-machine state directory (host identity + device registry). */
  remoteDir: string
  relayUrl?: string
  hostSecret?: string
  apiBase?: string
  authToken?: string
  /** Start the QR account-link flow when no session token or relay is set. */
  setup?: boolean
  /** Base64-encoded Ed25519 SPKI key; enrollment supplies and persists it automatically. */
  remoteTokenPublicKey?: string
  /** Fresh pairing invite per session by default; disable for long-lived hosts. */
  createInvite?: boolean
  write?: (line: string) => void
  signal?: AbortSignal
  onSetup?: (setup: RemoteSetupPrompt) => void
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
  let identity = await ensureHostIdentity(options.remoteDir)
  let relayUrl = options.relayUrl
  const hostSecret = options.hostSecret ?? identity.relaySecret
  let remoteTokenPublicKey = options.remoteTokenPublicKey ?? identity.remoteTokenPublicKey

  if (options.authToken) {
    const enrollment = await registerHost({
      apiBase: options.apiBase ?? DEFAULT_CUPPET_API_BASE,
      token: options.authToken,
      identity,
      relaySecret: hostSecret,
    })
    relayUrl ??= enrollment.relayUrl
    if (enrollment.remoteTokenPublicKey) {
      identity = await setRemoteTokenPublicKey(options.remoteDir, enrollment.remoteTokenPublicKey)
      remoteTokenPublicKey = identity.remoteTokenPublicKey
    }
    if (enrollment.relayRegistered) write('  relay enrollment: registered\n')
  } else if (options.setup && !relayUrl) {
    const enrollment = await runRemoteSetup({
      apiBase: options.apiBase ?? DEFAULT_CUPPET_API_BASE,
      identity,
      write,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onSetup ? { onSetup: options.onSetup } : {}),
    })
    relayUrl = enrollment.relayUrl
    if (enrollment.remoteTokenPublicKey) {
      identity = await setRemoteTokenPublicKey(options.remoteDir, enrollment.remoteTokenPublicKey)
      remoteTokenPublicKey = identity.remoteTokenPublicKey
    }
    if (enrollment.relayRegistered) write('  relay enrollment: registered\n')
  }

  write(`Remote control\n  host: ${identity.hostId} (${identity.deviceName})\n`)
  for (const device of await listPairedDevices(options.remoteDir)) {
    write(`  paired: ${device.name} [${device.deviceId}] ${device.scopes.join(',')}\n`)
  }

  let bridge: RemoteBridge | undefined
  if (relayUrl) {
    const params = new URLSearchParams({
      role: 'host',
      hostId: identity.hostId,
      secret: hostSecret,
    })
    const transport = new WebSocketTransport(`${relayWebSocketUrl(relayUrl)}?${params}`)
    bridge = new RemoteBridge({
      controller: options.controller,
      hostId: identity.hostId,
      transport,
      authenticateDevice: async (deviceId, secret) => {
        const local = await authenticateDevice(options.remoteDir, deviceId, secret)
        if (local) return local
        if (!remoteTokenPublicKey) return undefined
        return verifyRemoteToken(secret, remoteTokenPublicKey, identity.hostId, deviceId)
      },
      claimPairingInvite: (code, deviceName) => claimPairingInvite(options.remoteDir, code, deviceName),
      buildAttachSnapshot: async () => ({
        snapshot: options.controller.snapshot,
        permissions: await options.controller.listPendingPermissions().catch(() => []),
        questions: await options.controller.listPendingQuestions().catch(() => []),
      }),
    })
    bridge.start()
    write(`  relay: dialing ${relayUrl}\n`)
  } else {
    write('  set CUPPET_RELAY_URL or pass --relay-url <wss://…> to connect the bridge\n')
  }

  let invite: PairingInvite & { url: string | undefined } | undefined
  if (options.createInvite ?? true) {
    invite = await createPairingInvite(options.remoteDir, {
      ...(relayUrl ? { relayUrl } : {}),
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
