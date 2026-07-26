import { stripVTControlCharacters } from 'node:util'
import type { MessageItem } from '../types.js'

export type ViewportLayout = {
  terminalRows: number
  reserved: number
  rows: number
  header: number
  body: number
  messages: number
  editor: number
  modal: number
  footer: number
}

export type MessageLineKind =
  | 'text'
  | 'code-header'
  | 'code'
  | 'diagram-header'
  | 'diagram-edge'
  | 'table-header'
  | 'table-divider'
  | 'table-row'

export type MessageLine = {
  id: string
  sender: MessageItem['sender']
  text: string
  kind: MessageLineKind
  language?: string
  /** @deprecated Use kind === 'code' instead. */
  isCodeBlock?: boolean
}

export function viewportLayout(rows: number, modalOpen: boolean): ViewportLayout {
  const terminalRows = Math.max(1, Number.isFinite(rows) ? Math.floor(rows) : 24)
  // Ink falls back to clearing the whole terminal when its render consumes the
  // last physical row. Leaving one row free keeps the interactive surface in
  // the normal terminal buffer and preserves native scrollback.
  const reserved = 1
  const available = Math.max(0, terminalRows - reserved)
  const header = !modalOpen && available >= 3 ? 1 : 0
  const footer = available >= 2 ? 1 : 0
  const body = Math.max(0, available - header - footer)
  if (modalOpen) {
    return {
      terminalRows,
      reserved,
      rows: available,
      header,
      body,
      messages: 0,
      editor: 0,
      modal: body,
      footer,
    }
  }
  const editor = body >= 5
    ? Math.min(5, Math.max(4, Math.floor(body / 3)))
    : body
  return {
    terminalRows,
    reserved,
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
    const sourceLines = (cleanText || message.text).split('\n')
    let inCodeBlock = false
    let codeLanguage = 'text'
    const result: MessageLine[] = []
    let lineIdx = 0

    const addLine = (
      text: string,
      kind: MessageLineKind,
      metadata: Pick<MessageLine, 'language' | 'isCodeBlock'> = {},
    ) => {
      result.push({
        id: `${message.id}:${lineIdx++}`,
        sender: message.sender,
        text: kind === 'code' ? text || ' ' : text || ' ',
        kind,
        ...metadata,
      })
    }

    const addWrappedLine = (
      value: string,
      kind: MessageLineKind,
      metadata: Pick<MessageLine, 'language' | 'isCodeBlock'> = {},
    ) => {
      const wrapped = wrapTerminalText(value, width)
      for (const text of wrapped) {
        addLine(text, kind, metadata)
      }
    }

    for (let i = 0; i < sourceLines.length; i += 1) {
      const sourceLine = sourceLines[i] ?? ''
      const trimmed = sourceLine.trimStart()
      const isCodeFence = trimmed.startsWith('```')

      if (isCodeFence) {
        if (!inCodeBlock) {
          const language = trimmed.slice(3).trim().split(/\s+/)[0]
          codeLanguage = language || 'text'
          if (codeLanguage.toLowerCase() === 'mermaid') {
            const diagramLines: string[] = []
            let end = i + 1
            while (end < sourceLines.length && !(sourceLines[end] ?? '').trimStart().startsWith('```')) {
              diagramLines.push(sourceLines[end] ?? '')
              end += 1
            }
            for (const line of renderMermaidDiagram(diagramLines)) {
              addWrappedLine(line.text, line.kind)
            }
            i = end
            continue
          }
          inCodeBlock = true
          addLine(codeLanguage, 'code-header', { language: codeLanguage })
        } else {
          inCodeBlock = false
        }
        continue
      }

      if (inCodeBlock) {
        if (!sourceLine.trim()) continue
        addWrappedLine(sourceLine, 'code', { language: codeLanguage, isCodeBlock: true })
        continue
      }

      const headerCells = parseMarkdownTableRow(sourceLine)
      if (headerCells && isMarkdownTableDivider(sourceLines[i + 1])) {
        const rows: string[][] = []
        let end = i + 2
        while (end < sourceLines.length) {
          const row = parseMarkdownTableRow(sourceLines[end] ?? '')
          if (!row) break
          rows.push(row)
          end += 1
        }
        for (const line of renderMarkdownTable(headerCells, rows, width)) {
          addLine(line.text, line.kind)
        }
        i = end - 1
        continue
      }

      // Paragraph spacing should not consume a large part of a small terminal
      // viewport. Markdown still reads clearly without blank-only rows.
      if (!sourceLine.trim()) continue

      const displayLine = i === 0 ? `${prefix}${sourceLine}` : sourceLine
      addWrappedLine(displayLine, 'text')
    }
    return result
  })
}

type RenderedMarkdownLine = {
  kind: Extract<MessageLineKind, 'diagram-header' | 'diagram-edge' | 'table-header' | 'table-divider' | 'table-row'>
  text: string
}

function renderMermaidDiagram(sourceLines: string[]): RenderedMarkdownLine[] {
  const labels = new Map<string, string>()
  for (const sourceLine of sourceLines) {
    for (const match of sourceLine.matchAll(/([A-Za-z][\w-]*)\s*(?:\[\s*([^\]]+?)\s*\]|\{\s*([^}]+?)\s*\}|\(\(\s*([^)]+?)\s*\)\)|\(\s*([^)]+?)\s*\))/g)) {
      const id = match[1]
      const label = cleanDiagramLabel(match[2] ?? match[3] ?? match[4] ?? match[5] ?? id ?? '')
      if (id && label) labels.set(id, label)
    }
  }

  const edges: string[] = []
  for (const sourceLine of sourceLines) {
    const arrow = sourceLine.indexOf('-->')
    if (arrow < 0) continue
    let left = sourceLine.slice(0, arrow).trim()
    let right = sourceLine.slice(arrow + 3).trim()
    let edgeLabel = ''

    const labelledLeft = /^(.*?)\s+--\s*(.*?)\s*$/.exec(left)
    if (labelledLeft) {
      left = labelledLeft[1] ?? left
      edgeLabel = cleanDiagramLabel(labelledLeft[2] ?? '')
    }
    const labelledRight = /^\|([^|]+)\|\s*(.*)$/.exec(right)
    if (labelledRight) {
      edgeLabel ||= cleanDiagramLabel(labelledRight[1] ?? '')
      right = labelledRight[2] ?? right
    }

    const fromID = mermaidNodeID(left)
    const toID = mermaidNodeID(right)
    if (!fromID || !toID) continue
    const from = labels.get(fromID) ?? fromID
    const to = labels.get(toID) ?? toID
    edges.push(`${from}${edgeLabel ? ` — ${edgeLabel}` : ''} → ${to}`)
  }

  if (edges.length === 0) {
    const fallback = sourceLines
      .map((line) => cleanDiagramLabel(line))
      .filter((line) => line && !/^(flowchart|graph|subgraph|end)\b/i.test(line))
    return [
      { kind: 'diagram-header', text: 'Flowmap' },
      ...fallback.map((text) => ({ kind: 'diagram-edge' as const, text })),
    ]
  }

  return [
    { kind: 'diagram-header', text: 'Flowmap' },
    ...edges.map((text) => ({ kind: 'diagram-edge' as const, text })),
  ]
}

function mermaidNodeID(value: string): string | undefined {
  return /^\s*([A-Za-z][\w-]*)/.exec(value)?.[1]
}

function cleanDiagramLabel(value: string): string {
  return value
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/[`"']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseMarkdownTableRow(value: string): string[] | undefined {
  const trimmed = value.trim()
  if (!trimmed.includes('|')) return undefined
  const content = trimmed.replace(/^\|/, '').replace(/\|$/, '')
  const cells = content.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim())
  return cells.length >= 2 ? cells : undefined
}

function isMarkdownTableDivider(value: string | undefined): boolean {
  const cells = value ? parseMarkdownTableRow(value) : undefined
  return Boolean(cells?.length && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim())))
}

function renderMarkdownTable(headers: string[], rows: string[][], width: number): RenderedMarkdownLine[] {
  const columnCount = Math.max(headers.length, ...rows.map((row) => row.length))
  const separatorWidth = Math.max(0, columnCount - 1) * 3
  const cellWidth = Math.max(3, Math.floor(Math.max(columnCount * 3, width - separatorWidth) / columnCount))
  const widths = Array.from({ length: columnCount }, () => cellWidth)
  const formatRow = (cells: string[]) => widths
    .map((cellWidthForColumn, index) => padTerminalText(truncateTerminalText(cells[index] ?? '', cellWidthForColumn), cellWidthForColumn))
    .join(' │ ')

  return [
    { kind: 'table-header', text: formatRow(headers) },
    { kind: 'table-divider', text: widths.map((cell) => '─'.repeat(cell)).join('─┼─') },
    ...rows.map((row) => ({ kind: 'table-row' as const, text: formatRow(row) })),
  ]
}

function truncateTerminalText(value: string, width: number): string {
  let output = ''
  let used = 0
  for (const { segment } of graphemeSegmenter.segment(stripVTControlCharacters(value))) {
    const size = terminalWidth(segment)
    if (used + size > width) return `${output.slice(0, Math.max(0, output.length - 1))}…`
    output += segment
    used += size
  }
  return output
}

function padTerminalText(value: string, width: number): string {
  let used = 0
  for (const { segment } of graphemeSegmenter.segment(value)) used += terminalWidth(segment)
  return `${value}${' '.repeat(Math.max(0, width - used))}`
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
