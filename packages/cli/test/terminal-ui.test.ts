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
    const initialFrame = latestFrame(chunks)
    assertFrameHeightBelowTerminal(initialFrame, 10)
    const initialLines = initialFrame.split('\n')
    assert.equal(initialLines.findIndex((line) => line.includes('Tokens')), initialLines.length - 1, 'the composer footer should stay at the bottom of the live terminal surface')

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
    const footerIndex = lines.findIndex((line) => line.includes('Tokens'))
    assert.ok(messageIndex >= 0)
    assert.ok(headerIndex > messageIndex, 'the model header should follow the transcript')
    assert.equal(headerIndex, messageIndex + 1, 'the newest transcript line should sit directly above the composer surface')
    assert.ok(composerIndex > headerIndex, 'the model header should sit above the composer')
    assert.equal(footerIndex, lines.length - 1, 'the composer should remain pinned to the bottom of the live surface')
    assert.doesNotMatch(frame, /Cuppet public alpha/i)
  } finally {
    app.unmount()
    stdin.destroy()
    stdout.destroy()
  }
})

test('tool phases do not split a short transcript with blank rows', async () => {
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
    controller.emitAgentEvent({ type: 'text-delta', sessionID: 'sess-phases', text: 'I’ll review the pending FAQ changes.' })
    controller.emitAgentEvent({ type: 'tool-start', sessionID: 'sess-phases', callID: 'status', name: 'bash', input: { command: 'git status' } })
    controller.emitAgentEvent({ type: 'tool-end', sessionID: 'sess-phases', callID: 'status', success: true, outputBytes: 0, resultCount: 0, truncated: false, cacheHit: false })
    controller.emitAgentEvent({ type: 'idle', sessionID: 'sess-phases' })
    controller.emitAgentEvent({ type: 'tool-start', sessionID: 'sess-phases', callID: 'add', name: 'bash', input: { command: 'git add src/sections/FAQ.tsx' } })
    controller.emitAgentEvent({ type: 'tool-end', sessionID: 'sess-phases', callID: 'add', success: true, outputBytes: 0, resultCount: 0, truncated: false, cacheHit: false })
    controller.emitAgentEvent({ type: 'text-delta', sessionID: 'sess-phases', text: 'Committed and pushed the FAQ section.' })
    controller.emitAgentEvent({ type: 'idle', sessionID: 'sess-phases' })
    await settle()

    const lines = latestFrame(chunks).split('\n')
    const reviewIndex = lines.findIndex((line) => line.includes('pending FAQ changes'))
    const statusIndex = lines.findIndex((line) => line.includes('git status'))
    const addIndex = lines.findIndex((line) => line.includes('git add src/sections/FAQ.tsx'))
    const committedIndex = lines.findIndex((line) => line.includes('Committed and pushed'))
    assert.ok(reviewIndex >= 0)
    assert.equal(statusIndex, reviewIndex + 1)
    assert.equal(addIndex, statusIndex + 1)
    assert.equal(committedIndex, addIndex + 1)
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

test('completion arrows leave the full terminal transcript visible', async () => {
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
    assert.match(latestFrame(chunks), /line 0/)
    assert.match(latestFrame(chunks), /line 19/)

    stdin.write('/')
    await settle()
    stdin.write('\u001b[B')
    await settle()
    const frame = latestFrame(chunks)
    assert.match(frame, /› \/login/)
    assert.match(frame, /line 0/)
    assert.match(frame, /line 19/)
  } finally {
    app.unmount()
    stdin.destroy()
    stdout.destroy()
  }
})

test('terminal UI preserves the full transcript in the normal terminal buffer', async () => {
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

    const frame = latestFrame(chunks)
    assert.match(frame, /History Line 1/)
    assert.match(frame, /History Line 20/)
    assert.ok(frame.split('\n').length > 12, 'the transcript should be allowed to exceed the physical viewport')
    assert.doesNotMatch(frame, /↑ \d+ lines back|PgDn or End for latest/)
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

test('completed transcript output does not clear the terminal when it exceeds the viewport', async () => {
  const stdin = terminalInput()
  const stdout = terminalOutput(60, 12)
  const chunks: string[] = []
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
  const controller = fakeController()
  const app = render(React.createElement(TerminalApp, {
    controller,
    dispatcher: { async dispatch() { return { handled: true } } } as unknown as CommandDispatcher,
  }), {
    stdin,
    stdout,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  })

  try {
    await settle()
    for (let i = 1; i <= 20; i += 1) {
      controller.emitAgentEvent({ type: 'text-delta', sessionID: 'sess-static', text: `Permanent Line ${i}\n` })
    }
    controller.emitAgentEvent({ type: 'idle', sessionID: 'sess-static' })
    await settle()

    const output = chunks.join('')
    assert.match(stripVTControlCharacters(output), /Permanent Line 1/)
    assert.match(stripVTControlCharacters(output), /Permanent Line 20/)
    assert.doesNotMatch(output, /\u001b\[2J/, 'completed history must not trigger Ink terminal clearing')
  } finally {
    app.unmount()
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
