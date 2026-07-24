import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { stripVTControlCharacters } from 'node:util'
import React from 'react'
import { render } from 'ink'
import type { CommandDispatcher } from '../src/commands/dispatcher.js'
import type { CuppetController } from '../src/controller.js'
import { TerminalApp } from '../src/ui/TerminalApp.js'

test('terminal UI stays inside the viewport and Esc closes a slash-command picker', async () => {
  const stdin = terminalInput()
  const stdout = terminalOutput(42, 10)
  const chunks: string[] = []
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
  const controller = fakeController()
  const dispatcher = {
    async dispatch(input: string) {
      if (input === '/platform') return { handled: true, action: { type: 'platform' as const } }
      return { handled: true }
    },
  } as CommandDispatcher
  const app = render(React.createElement(TerminalApp, { controller, dispatcher }), {
    stdin,
    stdout,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  })

  try {
    await settle()
    assertFrameHeight(latestFrame(chunks), 10)

    stdin.write('/platform')
    await settle()
    stdin.write('\r')
    await settle()
    assert.match(latestFrame(chunks), /Select platform/)
    assertFrameHeight(latestFrame(chunks), 10)

    stdin.write('\u001B')
    await settle()
    assert.doesNotMatch(latestFrame(chunks), /Select platform/)
    assert.match(latestFrame(chunks), /Type a request/)

    Object.defineProperty(stdout, 'rows', { configurable: true, value: 6, writable: true })
    stdout.emit('resize')
    await settle()
    assertFrameHeight(latestFrame(chunks), 6)
  } finally {
    app.unmount()
    stdin.destroy()
    stdout.destroy()
  }
})

test('terminal UI initializes alternate screen and alternate scroll modes and supports scrolling history', async () => {
  const stdin = terminalInput()
  const stdout = terminalOutput(60, 12)
  const chunks: string[] = []
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
  const controller = fakeController()
  const dispatcher = {
    async dispatch() { return { handled: false } },
  } as unknown as CommandDispatcher

  const app = render(React.createElement(TerminalApp, { controller, dispatcher }), {
    stdin,
    stdout,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  })

  try {
    await settle()
    const allRawOutput = chunks.join('')
    assert.ok(allRawOutput.includes('\u001b[?1049h\u001b[?1007h'), 'expected TTY mount to enable alternate screen and alternate scroll')

    // Trigger long assistant response lines
    for (let i = 1; i <= 20; i += 1) {
      controller.emitAgentEvent({ type: 'text-delta', sessionID: 'sess1', text: `History Line ${i}\n` })
    }
    controller.emitAgentEvent({ type: 'idle', sessionID: 'sess1' })
    await settle()

    // Verify scrolling indicators or line navigation
    stdin.write('\u001b[5~') // PageUp
    await settle()
    assert.match(latestFrame(chunks), /Scrolled \d+ lines back/)

    stdin.write('\u001b[6~') // PageDown (scroll back down)
    await settle()
    assert.doesNotMatch(latestFrame(chunks), /Scrolled/)

    // Test mouse wheel scroll up sequence
    stdin.write('\u001b[<64;10;10M')
    await settle()
    assert.match(latestFrame(chunks), /Scrolled/)

    // Test mouse wheel scroll down sequence
    stdin.write('\u001b[<65;10;10M')
    await settle()
    assert.doesNotMatch(latestFrame(chunks), /Scrolled/)

    // Test Up Arrow when scrolled back scrolls history line-by-line
    stdin.write('\u001b[5~') // PageUp first
    await settle()
    const frameAfterPageUp = latestFrame(chunks)
    assert.match(frameAfterPageUp, /Scrolled \d+ lines back/)

    stdin.write('\u001b[A') // Up Arrow line scroll
    await settle()
    assert.match(latestFrame(chunks), /Scrolled \d+ lines back/)
  } finally {
    app.unmount()
    await settle()
    const finalRawOutput = chunks.join('')
    assert.ok(finalRawOutput.includes('\u001b[?1007l\u001b[?1049l'), 'expected unmount to disable alternate scroll and alternate screen')
    stdin.destroy()
    stdout.destroy()
  }
})

function fakeController(): CuppetController & { emitAgentEvent(event: unknown): void } {
  const model = { providerID: 'openai', modelID: 'gpt-test' }
  const agentListeners = new Set<(event: unknown) => void>()
  const snapshot = {
    models: [],
    integrations: [],
    platform: 'openai' as const,
    primary: model,
    secondary: model,
    foregroundUsage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    foregroundCost: 0,
    running: false,
    activeTools: 0,
    degraded: false,
    stepCount: 0,
  }
  return {
    snapshot,
    onChange() { return () => undefined },
    onAgentEvent(listener: (event: unknown) => void) {
      agentListeners.add(listener)
      return () => { agentListeners.delete(listener) }
    },
    emitAgentEvent(event: unknown) {
      for (const listener of agentListeners) listener(event)
    },
    modelsForPlatform() { return [] },
    integrationsForPlatform() { return [] },
    async denyPendingPermissions() { return 0 },
    async replyPermission() {},
    gateway: { async cancelOAuth() {} },
  } as unknown as CuppetController & { emitAgentEvent(event: unknown): void }
}

function terminalInput(): NodeJS.ReadStream {
  const stream = new PassThrough() as PassThrough & NodeJS.ReadStream
  Object.assign(stream, {
    isTTY: true,
    setRawMode() { return stream },
    ref() { return stream },
    unref() { return stream },
  })
  return stream
}

function terminalOutput(columns: number, rows: number): NodeJS.WriteStream {
  const stream = new PassThrough() as PassThrough & NodeJS.WriteStream
  Object.defineProperties(stream, {
    columns: { configurable: true, value: columns, writable: true },
    rows: { configurable: true, value: rows, writable: true },
    isTTY: { configurable: true, value: true },
  })
  return stream
}

function latestFrame(chunks: string[]): string {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const frame = stripVTControlCharacters(chunks[index] ?? '')
    if (frame.includes('CUPPET')) return frame
  }
  throw new Error(`No UI frame in chunks: ${JSON.stringify(chunks)}`)
}

function assertFrameHeight(frame: string, rows: number): void {
  assert.ok(frame.length > 0, 'expected Ink to render a frame')
  assert.ok(frame.split('\n').length <= rows, `rendered ${frame.split('\n').length} rows into a ${rows}-row terminal`)
}

async function settle(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
