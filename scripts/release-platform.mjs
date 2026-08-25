export function canExecuteRuntime(manifest, host = { platform: process.platform, arch: process.arch }) {
  return manifest.platform === host.platform
    && manifest.arch === host.arch
    && (manifest.platform !== 'linux' || manifest.libc === 'glibc')
}
