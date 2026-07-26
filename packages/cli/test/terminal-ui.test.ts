import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { stripVTControlCharacters } from 'node:util'
import React from 'react'
import { render } from 'ink'
import type { CommandDispatcher } from '../src/commands/dispatcher.js'
import type { CuppetController } from '../src/controller.js'
import type { ModelInfo, ModelRef } from '../src/types.js'
import { TerminalApp } from '../src/ui/TerminalApp.js'

test('terminal UI stays below the physical viewport and Esc closes a slash-command picker', async () => {
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
    assertFrameHeightBelowTerminal(latestFrame(chunks), 10)

    stdin.write('/platform')
    await settle()
    stdin.write('\r')
    await settle()
    assert.match(latestFrame(chunks), /Select platform/)
    assertFrameHeightBelowTerminal(latestFrame(chunks), 10)

    stdin.write('\u001B')
    await settle()
    assert.doesNotMatch(latestFrame(chunks), /Select platform/)
    assert.match(latestFrame(chunks), /Type a request/)

    Object.defineProperty(stdout, 'rows', { configurable: true, value: 6, writable: true })
    stdout.emit('resize')
    await settle()
    assertFrameHeightBelowTerminal(latestFrame(chunks), 6)
  } finally {
    app.unmount()
    stdin.destroy()
    stdout.destroy()
  }
})

test('terminal UI dispatches the selected slash completion on Enter', async () => {
  const stdin = terminalInput()
  const stdout = terminalOutput(80, 14)
  const chunks: string[] = []
  const dispatched: string[] = []
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
  const app = render(React.createElement(TerminalApp, {
    controller: fakeController(),
    dispatcher: {
      async dispatch(input: string) {
        dispatched.push(input)
        return { handled: true }
      },
    } as CommandDispatcher,
  }), {
    stdin,
    stdout,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  })

  try {
    await settle()
    stdin.write('/st')
    await settle()
    assert.match(latestFrame(chunks), /› \/status/)

    stdin.write('\r')
    await settle()
    assert.deepEqual(dispatched, ['/status'])
  } finally {
    app.unmount()
    stdin.destroy()
    stdout.destroy()
  }
})

test('terminal UI keeps the active model above the composer and removes the alpha banner', async () => {
  const stdin = terminalInput()
  const stdout = terminalOutput(80, 14)
  const chunks: string[] = []
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
  const controller = fakeController()
  const app = render(React.createElement(TerminalApp, {
    controller,
    dispatcher: { async dispatch() { return { handled: true } } } as unknown as CommandDispatcher,
  }), {
    stdin,
    stdout,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  })

  try {
    await settle()
    controller.emitAgentEvent({ type: 'text-delta', sessionID: 'sess-layout', text: 'Transcript message' })
    controller.emitAgentEvent({ type: 'idle', sessionID: 'sess-layout' })
    await settle()

    const frame = latestFrame(chunks)
    const lines = frame.split('\n')
    const messageIndex = lines.findIndex((line) => line.includes('Transcript message'))
    const headerIndex = lines.findIndex((line) => line.includes('CUPPET'))
    const composerIndex = lines.findIndex((line) => line.includes('Type a request'))
    assert.ok(messageIndex >= 0)
    assert.ok(headerIndex > messageIndex, 'the model header should follow the transcript')
    assert.ok(composerIndex > headerIndex, 'the model header should sit above the composer')
    assert.doesNotMatch(frame, /Cuppet public alpha/i)
  } finally {
    app.unmount()
    stdin.destroy()
    stdout.destroy()
  }
})

test('terminal UI selects a model once, then asks for its effort', async () => {
  const stdin = terminalInput()
  const stdout = terminalOutput(80, 14)
  const chunks: string[] = []
  const selectedModels: ModelRef[] = []
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
  const app = render(React.createElement(TerminalApp, {
    controller: fakeController({
      models: [pickerModel(), pickerModel('low'), pickerModel('high')],
      selectedModels,
    }),
    dispatcher: {
      async dispatch(input: string) {
        return input === '/model primary'
          ? { handled: true, action: { type: 'model' as const, role: 'primary' as const } }
          : { handled: true }
      },
    } as CommandDispatcher,
  }), {
    stdin,
    stdout,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  })

  try {
    await settle()
    stdin.write('/model primary')
    await settle()
    stdin.write('\r')
    await settle()

    const modelFrame = latestFrame(chunks)
    assert.match(modelFrame, /Select primary model/)
    assert.equal((modelFrame.match(/GPT Test/g) ?? []).length, 1)
    assert.doesNotMatch(modelFrame, /\[low\]|\[high\]/)

    stdin.write('\r')
    await settle()
    assert.match(latestFrame(chunks), /Select primary effort for openai\/gpt-test/)
    assert.deepEqual(selectedModels, [])

    stdin.write('\r')
    await settle()
    assert.deepEqual(selectedModels, [{ providerID: 'openai', modelID: 'gpt-test', variant: 'low' }])
  } finally {
    app.unmount()
    stdin.destroy()
    stdout.destroy()
  }
})

test('completion arrows do not move the terminal transcript', async () => {
  const stdin = terminalInput()
  const stdout = terminalOutput(80, 14)
  const chunks: string[] = []
  const controller = fakeController()
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
  const app = render(React.createElement(TerminalApp, {
    controller,
    dispatcher: { async dispatch() { return { handled: true } } } as unknown as CommandDispatcher,
  }), {
    stdin,
    stdout,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  })

  try {
    await settle()
    for (let index = 0; index < 20; index += 1) {
      controller.emitAgentEvent({ type: 'text-delta', sessionID: 'sess-menu', text: `line ${index}\n` })
    }
    controller.emitAgentEvent({ type: 'idle', sessionID: 'sess-menu' })
    await settle()
    stdin.write('\u001b[5~')
    await settle()
    const before = /↑ (\d+) lines back/.exec(latestFrame(chunks))
    assert.ok(before?.[1])

    stdin.write('/')
    await settle()
    stdin.write('\u001b[B')
    await settle()
    const frame = latestFrame(chunks)
    assert.match(frame, /› \/login/)
    assert.match(frame, new RegExp(`↑ ${before[1]} lines back`))
  } finally {
    app.unmount()
    stdin.destroy()
    stdout.destroy()
  }
})

test('terminal UI stays in the normal buffer and supports keyboard transcript navigation', async () => {
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
    assert.doesNotMatch(allRawOutput, /\u001b\[\?1049[hl]|\u001b\[\?1007[hl]/, 'must not enter alternate screen or mouse tracking')
    assert.doesNotMatch(allRawOutput, /\u001b\[2J/, 'must not clear the physical terminal')
    assertFrameHeightBelowTerminal(latestFrame(chunks), 12)

    // Trigger long assistant response lines
    for (let i = 1; i <= 20; i += 1) {
      controller.emitAgentEvent({ type: 'text-delta', sessionID: 'sess1', text: `History Line ${i}\n` })
    }
    controller.emitAgentEvent({ type: 'idle', sessionID: 'sess1' })
    await settle()

    // Verify scrolling indicators or line navigation
    stdin.write('\u001b[5~') // PageUp
    await settle()
    assert.match(latestFrame(chunks), /↑ \d+ lines back/)

    stdin.write('\u001b[6~') // PageDown (scroll back down)
    await settle()
    assert.doesNotMatch(latestFrame(chunks), /lines back/)

    // Test Up Arrow when scrolled back scrolls history line-by-line
    stdin.write('\u001b[5~') // PageUp first
    await settle()
    const frameAfterPageUp = latestFrame(chunks)
    assert.match(frameAfterPageUp, /↑ \d+ lines back/)

    stdin.write('\u001b[A') // Up Arrow line scroll
    await settle()
    assert.match(latestFrame(chunks), /↑ \d+ lines back/)
    assertFrameHeightBelowTerminal(latestFrame(chunks), 12)
  } finally {
    app.unmount()
    await settle()
    const finalRawOutput = chunks.join('')
    assert.doesNotMatch(finalRawOutput, /\u001b\[\?1049[hl]|\u001b\[\?1007[hl]/, 'must not emit alternate-screen cleanup sequences')
    assert.doesNotMatch(finalRawOutput, /\u001b\[2J/, 'must not clear the physical terminal on unmount')
    stdin.destroy()
    stdout.destroy()
  }
})

test('terminal UI renders fenced code as a labelled panel without legacy rails', async () => {
  const stdin = terminalInput()
  const stdout = terminalOutput(80, 16)
  const chunks: string[] = []
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
  const controller = fakeController()
  const app = render(React.createElement(TerminalApp, {
    controller,
    dispatcher: { async dispatch() { return { handled: true } } } as unknown as CommandDispatcher,
  }), {
    stdin,
    stdout,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  })

  try {
    await settle()
    controller.emitAgentEvent({
      type: 'text-delta',
      sessionID: 'sess-code',
      text: 'Example:\n```typescript\n  const value = call(42) // keep indentation\n```',
    })
    controller.emitAgentEvent({ type: 'idle', sessionID: 'sess-code' })
    await settle()

    const frame = latestFrame(chunks)
    assert.match(frame, /typescript/)
    assert.match(frame, /  const value = call\(42\) \/\/ keep indentation/)
    assert.doesNotMatch(frame, /```|┌── typescript|│\s+const value/)
    assertFrameHeightBelowTerminal(frame, 16)
  } finally {
    app.unmount()
    stdin.destroy()
    stdout.destroy()
  }
})

function fakeController(options: { models?: ModelInfo[]; selectedModels?: ModelRef[] } = {}): CuppetController & { emitAgentEvent(event: unknown): void } {
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
    modelsForPlatform() { return options.models ?? [] },
    integrationsForPlatform() { return [] },
    recommendedSecondary() { return undefined },
    async selectModel(_role: 'primary' | 'secondary', model: ModelRef) { options.selectedModels?.push(model) },
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
    if (frame.trim()) return frame
  }
  throw new Error(`No UI frame in chunks: ${JSON.stringify(chunks)}`)
}

function pickerModel(variant?: string): ModelInfo {
  return {
    providerID: 'openai',
    modelID: 'gpt-test',
    ...(variant ? { variant } : {}),
    name: `GPT Test${variant ? ` [${variant}]` : ''}`,
    context: 128_000,
    output: 16_000,
    enabled: true,
    status: 'active',
    inputCost: 1,
    outputCost: 1,
    capabilities: { tools: true, input: ['text'], output: ['text'] },
  }
}

function assertFrameHeightBelowTerminal(frame: string, rows: number): void {
  assert.ok(frame.length > 0, 'expected Ink to render a frame')
  assert.ok(frame.split('\n').length < rows, `rendered ${frame.split('\n').length} rows into a ${rows}-row terminal`)
}

async function settle(ms = 50): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
