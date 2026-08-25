import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { PreferenceStore } from './config/preferences.js'
import { CuppetController } from './controller.js'
import {
  CuppetControlServer,
  createControlAddress,
  type RemoteControlManager,
  type RemoteControlStatus,
} from './control/server.js'
import { OpenCodeGateway } from './opencode/gateway.js'
import { startOpenCodeServer, type OpenCodeRuntime } from './opencode/server.js'
import { runNativeTui } from './opencode/tui.js'
import { CUPPET_VERSION } from './constants.js'
import { startRemoteControl, type RemoteControlSession } from './remote/bootstrap.js'
import { runEnroll } from './remote/enroll.js'
import { DEFAULT_RELAY_PORT, runRelayServer, shutdownSignal } from './remote/relay-main.js'
import { resolveRuntimeAssets } from './runtime/assets.js'
import { RedactedLogger, redact } from './runtime/logger.js'
import { createRuntimePaths } from './runtime/paths.js'
import { startTstDaemon, type TstRuntime } from './tst/supervisor.js'

type Arguments = {
  doctor: boolean
  prompt?: string
  help: boolean
  version: boolean
  mode: 'tui' | 'headless-remote' | 'relay-server' | 'enroll'
  remoteControl?: boolean
  relayUrl?: string
  relayPort?: number
  relayAuthFile?: string
  relayAppDir?: string
  relayAdminToken?: string
  relayOrigins: string[]
  enrollApiBase?: string
  enrollToken?: string
  enrollName?: string
  tuiArguments: string[]
}

const HELP = `Cuppet ${CUPPET_VERSION}

Usage:
  cuppet [flags]                     interactive TUI session
  cuppet --remote-control            TUI + remote control from phone/browser
  cuppet remote-control              headless host (no TUI) for servers/tmux
  cuppet relay [--port <n>]          self-hosted Cuppet relay
  cuppet remote-enroll               register this machine with a Cuppet account

Flags:
  --doctor                           print runtime diagnostics and exit
  --prompt <text>                    run one prompt headlessly and exit
  --relay-url <wss://…>              relay endpoint for remote control
                                     (env CUPPET_RELAY_URL)
  CUPPET_REMOTE_TOKEN_SECRET         optional shared secret for backend-issued
                                     short-lived mobile credentials
  -c, --continue                     pass --continue to the TUI
  -s, --session <id>                 pass --session to the TUI
  --fork                             pass --fork to the TUI
  -h, --help                         show this help
  -v, --version                      print version

Relay flags:
  --port <n>                         listen port (default 8787)
  --auth-file <path>                 JSON file of authorized hosts; enables auth
  --admin-token <token>              token for POST/DELETE /hosts enrollment
  --app-dir <path>                   serve a static PWA at /app
  --allow-origin <origin>            allowed browser Origin (repeatable)

Enrollment flags:
  --api-base <url>                   Cuppet API base (default https://api.cuppet.in)
  --token <jwt>                      Cuppet session token (env CUPPET_TOKEN)
  --name <label>                     display name for this machine

Remote control flow:
  1. cuppet remote-control --relay-url wss://relay.example.com
     (set CUPPET_RELAY_HOST_SECRET after enrolling the host with the relay)
  2. scan the printed QR / open the pairing URL within 2 minutes
  3. control the session from the phone while the machine stays authoritative

Managed-token flow:
  Set CUPPET_REMOTE_TOKEN_SECRET to the Sydney REMOTE_TOKEN_SECRET value on
  the host; mobile then refreshes short-lived credentials through the backend.
`

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2))
  if (arguments_.help) {
    process.stdout.write(HELP)
    return
  }
  if (arguments_.version) {
    process.stdout.write(`${CUPPET_VERSION}\n`)
    return
  }
  const major = Number(process.versions.node.split('.')[0])
  if (major < 22) throw new Error(`Node.js 22+ is required; current runtime is ${process.version}`)

  if (arguments_.mode === 'relay-server') {
    await runRelayServer({
      port: arguments_.relayPort ?? DEFAULT_RELAY_PORT,
      ...(arguments_.relayAuthFile ? { authFile: arguments_.relayAuthFile } : {}),
      ...(arguments_.relayAppDir ? { appDir: arguments_.relayAppDir } : {}),
      ...(arguments_.relayAdminToken ? { adminToken: arguments_.relayAdminToken } : {}),
      origins: arguments_.relayOrigins,
    })
    return
  }

  if (arguments_.mode === 'enroll') {
    await runEnroll({
      apiBase: arguments_.enrollApiBase ?? process.env.CUPPET_API_BASE ?? 'https://api.cuppet.in',
      ...(arguments_.enrollToken
        ? { token: arguments_.enrollToken }
        : process.env.CUPPET_TOKEN
          ? { token: process.env.CUPPET_TOKEN }
          : {}),
      ...(arguments_.enrollName ? { name: arguments_.enrollName } : {})
    })
    return
  }
  const paths = await createRuntimePaths(process.cwd())
  const logger = new RedactedLogger(paths.logs)
  const assets = await resolveRuntimeAssets()
  if (!assets.opencode) {
    throw new Error(`Pinned OpenCode runtime is unavailable. ${assets.diagnostics.join(' ')}`)
  }

  let tst: TstRuntime | undefined
  let opencode: OpenCodeRuntime | undefined
  let controller: CuppetController | undefined
  let control: CuppetControlServer | undefined
  let remote: RemoteControlSession | undefined
  let tuiExitCode = 0
  const controlAddress = createControlAddress(paths)
  try {
    const preferences = new PreferenceStore(paths.preferences)
    await preferences.load()
    if (assets.tst) {
      try {
        tst = await startTstDaemon(assets.tst, paths, logger)
      } catch (error) {
        await logger.write('error', `TST degraded mode: ${(error as Error).message}`)
      }
    }
    opencode = await startOpenCodeServer({
      binary: assets.opencode,
      paths,
      logger,
      ...(assets.plugin ? { plugin: assets.plugin } : {}),
      ...(assets.tuiPlugin ? { tuiPlugin: assets.tuiPlugin } : {}),
      control: controlAddress,
      ...(tst ? { tst: { socket: tst.socket, token: tst.token } } : {}),
      ...(preferences.value.secondary ? { secondaryModel: preferences.value.secondary } : {}),
      ...(preferences.value.vertexProject ? { vertexProject: preferences.value.vertexProject } : {}),
    })
    const gateway = new OpenCodeGateway(opencode.client, paths.projectRealpath)
    controller = new CuppetController({
      gateway,
      ...(tst ? { tst: tst.client } : {}),
      preferences,
      paths,
      assets,
      vertex: opencode.vertex,
      interactive: !arguments_.prompt,
    })
    await controller.initialize()

    if (arguments_.doctor) {
      process.stdout.write(`${JSON.stringify(await controller.doctor(), null, 2)}\n`)
      return
    }
    if (arguments_.prompt) {
      const state = controller.snapshot
      if (!state.platform || !state.primary || !state.secondary) {
        throw new Error('First launch requires interactive platform, primary model, and secondary model selection')
      }
      const output = await controller.submitAndWait(arguments_.prompt)
      process.stdout.write(`${output}\n`)
      return
    }

    const relayUrl = arguments_.relayUrl ?? process.env.CUPPET_RELAY_URL
    const startRemoteSession = async (
      write: (line: string) => void = (line) => process.stdout.write(line),
    ): Promise<RemoteControlStatus> => {
      if (!controller) throw new Error('Cuppet controller is unavailable')
      if (!remote) {
        remote = await startRemoteControl({
          controller,
          remoteDir: join(paths.base, 'remote'),
          ...(relayUrl ? { relayUrl } : {}),
          ...(process.env.CUPPET_RELAY_HOST_SECRET ? { hostSecret: process.env.CUPPET_RELAY_HOST_SECRET } : {}),
          ...(process.env.CUPPET_REMOTE_TOKEN_SECRET ? { remoteTokenSecret: process.env.CUPPET_REMOTE_TOKEN_SECRET } : {}),
          write,
        })
      }
      return remoteControlStatus(remote)
    }
    const remoteManager: RemoteControlManager = {
      start: () => startRemoteSession(() => undefined),
      stop: () => {
        remote?.stop()
        remote = undefined
        return { running: false }
      },
      status: () => remote ? remoteControlStatus(remote) : { running: false },
    }
    control = await CuppetControlServer.start(controller, paths, controlAddress, { remote: remoteManager })

    if (arguments_.mode === 'headless-remote' || arguments_.remoteControl || relayUrl) {
      await startRemoteSession()
    }

    if (arguments_.mode === 'headless-remote') {
      await shutdownSignal()
      return
    }
    tuiExitCode = await runNativeTui({
      binary: assets.opencode,
      url: opencode.url,
      directory: paths.projectRealpath,
      username: opencode.auth.username,
      password: opencode.auth.password,
      xdg: paths.opencode,
      arguments: arguments_.tuiArguments,
      environment: {
        CUPPET_CONTROL_SOCKET: control.address.socket,
        CUPPET_CONTROL_TOKEN: control.address.token,
        ...(tst ? { CUPPET_TST_SOCKET: tst.socket, CUPPET_TST_TOKEN: tst.token } : {}),
      },
    })
  } finally {
    remote?.stop()
    await control?.close().catch(() => undefined)
    await controller?.close().catch(() => undefined)
    await opencode?.close().catch(() => undefined)
    await tst?.close().catch(() => undefined)
    await rm(paths.runtime, { recursive: true, force: true }).catch(() => undefined)
  }
  if (tuiExitCode !== 0) process.exitCode = tuiExitCode
}

function remoteControlStatus(session: RemoteControlSession): RemoteControlStatus {
  const invite = session.invite
  return {
    running: true,
    hostId: session.identity.hostId,
    deviceName: session.identity.deviceName,
    ...(invite ? {
      invite: {
        code: invite.code,
        expiresAt: invite.expiresAt,
        ...(invite.url ? { url: invite.url } : {}),
      },
    } : {}),
  }
}

function parseArguments(arguments_: string[]): Arguments {
  const result: Arguments = { doctor: false, help: false, version: false, mode: 'tui', relayOrigins: [], tuiArguments: [] }
  const rest = [...arguments_]
  // Leading positional subcommand selects the mode; everything else is flags.
  if (rest[0] === 'remote-control') {
    result.mode = 'headless-remote'
    rest.shift()
  } else if (rest[0] === 'relay') {
    result.mode = 'relay-server'
    rest.shift()
  } else if (rest[0] === 'remote-enroll') {
    result.mode = 'enroll'
    rest.shift()
  }
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]
    if (argument === '--doctor') result.doctor = true
    else if (argument === '--remote-control') result.remoteControl = true
    else if (argument === '--relay-url') {
      const value = rest[index + 1]
      if (!value) throw new Error('--relay-url requires a value')
      result.relayUrl = value
      index += 1
    } else if (argument === '--port') {
      const value = Number(rest[index + 1])
      if (!Number.isInteger(value) || value <= 0 || value > 65_535) throw new Error('--port requires a port number')
      result.relayPort = value
      index += 1
    } else if (argument === '--auth-file') {
      const value = rest[index + 1]
      if (!value) throw new Error('--auth-file requires a path')
      result.relayAuthFile = value
      index += 1
    } else if (argument === '--app-dir') {
      const value = rest[index + 1]
      if (!value) throw new Error('--app-dir requires a path')
      result.relayAppDir = value
      index += 1
    } else if (argument === '--admin-token') {
      const value = rest[index + 1]
      if (!value) throw new Error('--admin-token requires a value')
      result.relayAdminToken = value
      index += 1
    } else if (argument === '--allow-origin') {
      const value = rest[index + 1]
      if (!value) throw new Error('--allow-origin requires an origin')
      result.relayOrigins.push(value)
      index += 1
    } else if (argument === '--api-base') {
      const value = rest[index + 1]
      if (!value) throw new Error('--api-base requires a URL')
      result.enrollApiBase = value
      index += 1
    } else if (argument === '--token') {
      const value = rest[index + 1]
      if (!value) throw new Error('--token requires a value')
      result.enrollToken = value
      index += 1
    } else if (argument === '--name') {
      const value = rest[index + 1]
      if (!value) throw new Error('--name requires a value')
      result.enrollName = value
      index += 1
    } else if (argument === '--help' || argument === '-h') result.help = true
    else if (argument === '--version' || argument === '-v') result.version = true
    else if (argument === '--prompt') {
      const prompt = rest[index + 1]
      if (!prompt) throw new Error('--prompt requires a value')
      result.prompt = prompt
      index += 1
    } else if (argument === '--continue' || argument === '-c') {
      result.tuiArguments.push('--continue')
    } else if (argument === '--session' || argument === '-s') {
      const session = rest[index + 1]
      if (!session) throw new Error(`${argument} requires a session id`)
      result.tuiArguments.push('--session', session)
      index += 1
    } else if (argument === '--fork') {
      result.tuiArguments.push('--fork')
    } else throw new Error(`Unknown argument ${argument}`)
  }
  return result
}

main().catch((error) => {
  const message = redact(error instanceof Error ? error.message : String(error))
  process.stderr.write(`Cuppet failed: ${message}\n`)
  process.exitCode = 1
})
