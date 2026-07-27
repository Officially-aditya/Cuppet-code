import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nativeTuiEnvironment, type NativeTuiOptions } from '../src/opencode/tui.js'

test('native attach TUI uses Cuppet isolated XDG paths and launch-scoped control variables', () => {
  const options: NativeTuiOptions = {
    binary: '/runtime/opencode',
    url: 'http://127.0.0.1:1234',
    directory: '/project',
    username: 'cuppet',
    password: 'secret',
    xdg: {
      config: '/private/config',
      data: '/private/data',
      cache: '/private/cache',
      state: '/private/state',
    },
    environment: {
      CUPPET_CONTROL_SOCKET: '/private/control.sock',
      CUPPET_CONTROL_TOKEN: 'token',
    },
  }
  const environment = nativeTuiEnvironment(options)
  assert.equal(environment.XDG_CONFIG_HOME, '/private/config')
  assert.equal(environment.XDG_DATA_HOME, '/private/data')
  assert.equal(environment.XDG_CACHE_HOME, '/private/cache')
  assert.equal(environment.XDG_STATE_HOME, '/private/state')
  assert.equal(environment.OPENCODE_SERVER_USERNAME, 'cuppet')
  assert.equal(environment.OPENCODE_SERVER_PASSWORD, 'secret')
  assert.equal(environment.CUPPET_CONTROL_SOCKET, '/private/control.sock')
  assert.equal(environment.CUPPET_CONTROL_TOKEN, 'token')
})
