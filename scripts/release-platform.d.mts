export type RuntimeManifest = {
  platform: string
  arch: string
  libc?: string | null
}

export type RuntimeHost = {
  platform: string
  arch: string
}

export declare function canExecuteRuntime(manifest: RuntimeManifest, host?: RuntimeHost): boolean
