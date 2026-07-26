import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { stripVTControlCharacters } from 'node:util'
import React from 'react'
import { render } from 'ink'
import { COMMAND_COMPLETIONS } from '../src/commands/dispatcher.js'
import { MultilineEditor } from '../src/ui/MultilineEditor.js'

test('command completion selects with arrows and Tab inserts without dispatching', async () => {
  const stdin = terminalInput()
  const stdout = terminalOutput()
  const chunks: string[] = []
  const submissions: string[] = []
  let transcriptUp = 0
  let transcriptDown = 0
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
  const app = render(
    React.createElement(MultilineEditor, {
      height: 6,
      scrollOffset: 4,
      onSubmit: (value: string) => { submissions.push(value) },
      onScrollLineUp: () => { transcriptUp += 1 },
      onScrollLineDown: () => { transcriptDown += 1 },
    }),
    { stdin, stdout, debug: true, patchConsole: false, exitOnCtrlC: false },
  )

  try {
    await settle()
    stdin.write('/st')
    await settle()
    assert.match(latestFrame(chunks), /› \/status/)

    stdin.write('\t')
    await settle()
    assert.deepEqual(submissions, [])
    assert.match(latestFrame(chunks), /\/status/)

    stdin.write('\r')
    await settle()
    assert.deepEqual(submissions, ['/status'])

    stdin.write('/')
    await settle()
    assert.match(latestFrame(chunks), new RegExp(`› ${escapeRegex(COMMAND_COMPLETIONS[0]!.command)}`))

    stdin.write('\u001b[B')
    await settle()
    assert.equal(transcriptUp, 0)
    assert.equal(transcriptDown, 0)
    assert.match(latestFrame(chunks), new RegExp(`› ${escapeRegex(COMMAND_COMPLETIONS[1]!.command)}`))

    stdin.write('\r')
    await settle()
    assert.deepEqual(submissions, ['/status', COMMAND_COMPLETIONS[1]!.command])
  } finally {
    app.unmount()
    stdin.destroy()
    stdout.destroy()
  }
})

test('completion Esc retains input once, then editor falls back to raw arguments and history', async () => {
  const stdin = terminalInput()
  const stdout = terminalOutput()
  const chunks: string[] = []
  const submissions: string[] = []
  stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
  const app = render(
    React.createElement(MultilineEditor, {
      height: 6,
      onSubmit: (value: string) => { submissions.push(value) },
    }),
    { stdin, stdout, debug: true, patchConsole: false, exitOnCtrlC: false },
  )

  try {
    await settle()
    stdin.write('/st')
    await settle()
    stdin.write('\u001b')
    await settle()
    assert.match(latestFrame(chunks), /\/st/)

    stdin.write('\r')
    await settle()
    assert.deepEqual(submissions, ['/st'])

    stdin.write('/st')
    await settle()
    stdin.write('\u001b')
    await settle()
    stdin.write('\u001b')
    await settle()
    assert.match(latestFrame(chunks), /Type a request or \/help/)

    stdin.write('/steer inspect parser arguments')
    await settle()
    stdin.write('\r')
    await settle()
    assert.equal(submissions.at(-1), '/steer inspect parser arguments')

    stdin.write('first')
    await settle()
    stdin.write('\r')
    await settle()
    stdin.write('second')
    await settle()
    stdin.write('\r')
    await settle()
    stdin.write('\u001b[A')
    await settle()
    assert.match(latestFrame(chunks), /second/)
    stdin.write('\r')
    await settle()
    assert.equal(submissions.at(-1), 'second')
  } finally {
    app.unmount()
    stdin.destroy()
    stdout.destroy()
  }
})

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

function terminalOutput(): NodeJS.WriteStream {
  const stream = new PassThrough() as PassThrough & NodeJS.WriteStream
  Object.defineProperties(stream, {
    columns: { configurable: true, value: 90, writable: true },
    rows: { configurable: true, value: 16, writable: true },
    isTTY: { configurable: true, value: true },
  })
  return stream
}

function latestFrame(chunks: string[]): string {
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const frame = stripVTControlCharacters(chunks[index] ?? '')
    if (frame.includes('› ') || frame.includes('Type a request')) return frame
  }
  throw new Error(`No editor frame in chunks: ${JSON.stringify(chunks)}`)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function settle(ms = 40): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
