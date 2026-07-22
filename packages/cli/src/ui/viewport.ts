import { stripVTControlCharacters } from 'node:util'
import type { MessageItem } from '../types.js'

export type ViewportLayout = {
  rows: number
  header: number
  body: number
  messages: number
  editor: number
  modal: number
  footer: number
}

export type MessageLine = {
  id: string
  sender: MessageItem['sender']
  text: string
}

export function viewportLayout(rows: number, modalOpen: boolean): ViewportLayout {
  const available = Math.max(1, Number.isFinite(rows) ? Math.floor(rows) : 24)
  const header = available >= 8 ? 3 : available >= 3 ? 1 : 0
  const footer = available >= 2 ? 1 : 0
  const body = Math.max(0, available - header - footer)
  if (modalOpen) {
    return { rows: available, header, body, messages: 0, editor: 0, modal: body, footer }
  }
  const editor = body >= 6
    ? Math.min(5, Math.max(3, Math.floor(body / 3)))
    : body >= 4
      ? 3
      : body
  return {
    rows: available,
    header,
    body,
    messages: Math.max(0, body - editor),
    editor,
    modal: 0,
    footer,
  }
}

export function renderMessageLines(messages: MessageItem[], columns: number): MessageLine[] {
  const width = Math.max(1, Math.floor(columns))
  return messages.flatMap((message) => {
    const cleanText = message.text
      .replace(/<execute_tool>[\s\S]*?<\/execute_tool>/gi, '')
      .replace(/<\/?execute_tool>/gi, '')
      .trim()
    if (!cleanText && message.sender === 'assistant') return []
    const isDiff = message.text.startsWith('diff ') || message.text.startsWith('@@') || message.text.startsWith('+') || message.text.startsWith('-')
    const prefix = message.sender === 'user'
      ? '› '
      : message.sender === 'tool' && !isDiff
        ? '⚙ '
        : message.sender === 'system'
          ? 'ℹ '
          : ''
    const wrapped = wrapTerminalText(`${prefix}${cleanText || message.text}`, width)
    return wrapped.map((text, index) => ({
      id: `${message.id}:${index}`,
      sender: message.sender,
      text: text || ' ',
    }))
  })
}

function wrapTerminalText(value: string, columns: number): string[] {
  const result: string[] = []
  const text = stripVTControlCharacters(value).replaceAll('\t', '    ')
  for (const sourceLine of text.split('\n')) {
    let line = ''
    let width = 0
    for (const { segment } of graphemeSegmenter.segment(sourceLine)) {
      const next = terminalWidth(segment)
      if (line && width + next > columns) {
        result.push(line)
        line = ''
        width = 0
      }
      line += segment
      width += next
    }
    result.push(line)
  }
  return result
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function terminalWidth(value: string): number {
  if (/^[\p{Mark}\p{Control}\u200d\ufe0e\ufe0f]*$/u.test(value)) return 0
  if (/\p{Extended_Pictographic}/u.test(value)) return 2
  const point = value.codePointAt(0) ?? 0
  return isWideCodePoint(point) ? 2 : 1
}

function isWideCodePoint(point: number): boolean {
  return point >= 0x1100 && (
    point <= 0x115f ||
    point === 0x2329 ||
    point === 0x232a ||
    (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f) ||
    (point >= 0xac00 && point <= 0xd7a3) ||
    (point >= 0xf900 && point <= 0xfaff) ||
    (point >= 0xfe10 && point <= 0xfe19) ||
    (point >= 0xfe30 && point <= 0xfe6f) ||
    (point >= 0xff00 && point <= 0xff60) ||
    (point >= 0xffe0 && point <= 0xffe6) ||
    (point >= 0x20000 && point <= 0x3fffd)
  )
}

export function windowMessageLines(
  lines: MessageLine[],
  height: number,
  requestedOffset: number,
): { lines: MessageLine[]; offset: number; maxOffset: number } {
  const rows = Math.max(0, Math.floor(height))
  const maxOffset = Math.max(0, lines.length - rows)
  const offset = Math.min(maxOffset, Math.max(0, Math.floor(requestedOffset)))
  const end = Math.max(0, lines.length - offset)
  return {
    lines: rows > 0 ? lines.slice(Math.max(0, end - rows), end) : [],
    offset,
    maxOffset,
  }
}
