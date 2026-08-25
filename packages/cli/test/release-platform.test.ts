import assert from 'node:assert/strict'
import test from 'node:test'
import { canExecuteRuntime } from '../../../scripts/release-platform.mjs'

test('release verification executes only a matching native runtime', () => {
  assert.equal(canExecuteRuntime({ platform: 'darwin', arch: 'arm64', libc: null }, { platform: 'darwin', arch: 'arm64' }), true)
  assert.equal(canExecuteRuntime({ platform: 'linux', arch: 'x64', libc: 'glibc' }, { platform: 'linux', arch: 'arm64' }), false)
  assert.equal(canExecuteRuntime({ platform: 'linux', arch: 'arm64', libc: 'glibc' }, { platform: 'linux', arch: 'arm64' }), true)
  assert.equal(canExecuteRuntime({ platform: 'linux', arch: 'x64', libc: 'musl' }, { platform: 'linux', arch: 'x64' }), false)
})
