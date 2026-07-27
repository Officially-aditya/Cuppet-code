import { spawn } from 'node:child_process'

export type NativeTuiOptions = {
  binary: string
  url: string
  directory: string
  username: string
  password: string
  xdg: {
    config: string
    data: string
    cache: string
    state: string
  }
  arguments?: string[]
  environment?: Record<string, string>
}

/** Attach the pinned native Solid/OpenTUI client to Cuppet's private server. */
export async function runNativeTui(options: NativeTuiOptions): Promise<number> {
  const child = spawn(options.binary, ['attach', options.url, ...(options.arguments ?? [])], {
    cwd: options.directory,
    stdio: 'inherit',
    env: nativeTuiEnvironment(options),
  })

  const forwardSignal = (signal: NodeJS.Signals) => {
    if (child.exitCode === null) child.kill(signal)
  }
  const onInterrupt = () => forwardSignal('SIGINT')
  const onTerminate = () => forwardSignal('SIGTERM')
  process.once('SIGINT', onInterrupt)
  process.once('SIGTERM', onTerminate)
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve(code ?? signalExitCode(signal)))
    })
  } finally {
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
  }
}

export function nativeTuiEnvironment(options: NativeTuiOptions): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_CONFIG_HOME: options.xdg.config,
    XDG_DATA_HOME: options.xdg.data,
    XDG_CACHE_HOME: options.xdg.cache,
    XDG_STATE_HOME: options.xdg.state,
    OPENCODE_SERVER_USERNAME: options.username,
    OPENCODE_SERVER_PASSWORD: options.password,
    ...options.environment,
  }
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 1
  const signals = { SIGINT: 130, SIGTERM: 143 } as const
  return signals[signal as keyof typeof signals] ?? 1
}
