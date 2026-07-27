import { rm } from 'node:fs/promises'
import { PreferenceStore } from './config/preferences.js'
import { CuppetController } from './controller.js'
import { CuppetControlServer, createControlAddress } from './control/server.js'
import { OpenCodeGateway } from './opencode/gateway.js'
import { startOpenCodeServer, type OpenCodeRuntime } from './opencode/server.js'
import { runNativeTui } from './opencode/tui.js'
import { CUPPET_VERSION } from './constants.js'
import { resolveRuntimeAssets } from './runtime/assets.js'
import { RedactedLogger, redact } from './runtime/logger.js'
import { createRuntimePaths } from './runtime/paths.js'
import { startTstDaemon, type TstRuntime } from './tst/supervisor.js'

type Arguments = {
  doctor: boolean
  prompt?: string
  help: boolean
  version: boolean
  tuiArguments: string[]
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2))
  if (arguments_.help) {
    process.stdout.write(`Cuppet ${CUPPET_VERSION}\n\nUsage: cuppet [--doctor] [--prompt <text>] [-c|--continue] [-s|--session <id>] [--fork]\n`)
    return
  }
  if (arguments_.version) {
    process.stdout.write(`${CUPPET_VERSION}\n`)
    return
  }
  const major = Number(process.versions.node.split('.')[0])
  if (major < 22) throw new Error(`Node.js 22+ is required; current runtime is ${process.version}`)

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

    control = await CuppetControlServer.start(controller, paths, controlAddress)
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
    await control?.close().catch(() => undefined)
    await controller?.close().catch(() => undefined)
    await opencode?.close().catch(() => undefined)
    await tst?.close().catch(() => undefined)
    await rm(paths.runtime, { recursive: true, force: true }).catch(() => undefined)
  }
  if (tuiExitCode !== 0) process.exitCode = tuiExitCode
}

function parseArguments(arguments_: string[]): Arguments {
  const result: Arguments = { doctor: false, help: false, version: false, tuiArguments: [] }
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--doctor') result.doctor = true
    else if (argument === '--help' || argument === '-h') result.help = true
    else if (argument === '--version' || argument === '-v') result.version = true
    else if (argument === '--prompt') {
      const prompt = arguments_[index + 1]
      if (!prompt) throw new Error('--prompt requires a value')
      result.prompt = prompt
      index += 1
    } else if (argument === '--continue' || argument === '-c') {
      result.tuiArguments.push('--continue')
    } else if (argument === '--session' || argument === '-s') {
      const session = arguments_[index + 1]
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
