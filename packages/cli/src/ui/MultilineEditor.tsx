import React, { useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { COMMANDS } from '../commands/dispatcher.js'

type Props = {
  disabled?: boolean
  height?: number
  onSubmit(value: string): void | Promise<void>
  onScrollUp?(): void
  onScrollDown?(): void
}

export function MultilineEditor({ disabled = false, height = 4, onSubmit, onScrollUp, onScrollDown }: Props) {
  const [value, setValue] = useState('')
  const [historyIndex, setHistoryIndex] = useState(-1)
  const history = useRef<string[]>([])
  const suggestions = useMemo(() => {
    if (!value.startsWith('/') || value.includes('\n')) return []
    return COMMANDS.filter((command) => command.startsWith(value)).slice(0, 4)
  }, [value])

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') return
      const isMouseInput =
        input.startsWith('[<') ||
        input.startsWith('\u001b[<') ||
        input.startsWith('[M') ||
        input.startsWith('\u001b[M') ||
        /^\[<[0-9]+;/i.test(input)

      if (isMouseInput) {
        const button = parseInt(input.replace(/^[^\d]*/, ''), 10)
        if (button === 64 || button === 96 || input.includes('64;')) {
          onScrollUp?.()
        } else if (button === 65 || button === 97 || input.includes('65;')) {
          onScrollDown?.()
        }
        return
      }

      if (
        key.pageUp ||
        key.pageDown ||
        input === '\u0015' ||
        input === '\u0004' ||
        input.includes('\u001b[5~') ||
        input.includes('\u001b[6~') ||
        input === '\u001b[1;2A' ||
        input === '\u001b[1;2B' ||
        input === '\u001b[1;5A' ||
        input === '\u001b[1;5B'
      ) {
        if (
          key.pageUp ||
          input === '\u0015' ||
          input.includes('\u001b[5~') ||
          input === '\u001b[1;2A' ||
          input === '\u001b[1;5A'
        ) {
          onScrollUp?.()
        } else {
          onScrollDown?.()
        }
        return
      }
      if (key.escape) {
        setValue('')
        setHistoryIndex(-1)
        return
      }
      if (key.return) {
        if (key.ctrl || key.shift) {
          setValue((current) => `${current}\n`)
          return
        }
        const submitted = value.trim()
        if (!submitted) return
        history.current = [...history.current.filter((item) => item !== submitted), submitted].slice(-200)
        setValue('')
        setHistoryIndex(-1)
        void onSubmit(submitted)
        return
      }
      if (key.backspace || key.delete) {
        setValue((current) => Array.from(current).slice(0, -1).join(''))
        return
      }
      if (key.tab && suggestions[0]) {
        setValue(suggestions[0])
        return
      }
      if (key.upArrow && !value.includes('\n')) {
        const next = Math.min(history.current.length - 1, historyIndex + 1)
        if (next >= 0) {
          setHistoryIndex(next)
          setValue(history.current[history.current.length - 1 - next] ?? '')
        }
        return
      }
      if (key.downArrow && !value.includes('\n')) {
        const next = historyIndex - 1
        setHistoryIndex(next)
        setValue(next < 0 ? '' : (history.current[history.current.length - 1 - next] ?? ''))
        return
      }
      if (key.ctrl && input === 'n') {
        setValue((current) => `${current}\n`)
        return
      }
      if (input) {
        // Ink delivers bracketed paste as one input chunk; preserve embedded newlines.
        setValue((current) => `${current}${input.replace(/\r\n/g, '\n')}`)
      }
    },
    { isActive: !disabled },
  )

  const viewportHeight = Math.max(1, Math.floor(height))
  const lines = value.length > 0 ? value.split('\n') : ['']
  if (viewportHeight < 3) {
    const line = lines.at(-1) ?? ''
    return (
      <Box height={viewportHeight} overflow="hidden">
        <Text wrap="truncate-start">
          <Text color="cyan" bold>› </Text>
          {line || <Text dimColor>Type a request…</Text>}
          <Text inverse> </Text>
        </Text>
      </Box>
    )
  }

  const showSuggestions = suggestions.length > 0 && value !== suggestions[0] && viewportHeight >= 4
  const inputHeight = viewportHeight - (showSuggestions ? 1 : 0)
  const visibleLineCount = Math.max(1, inputHeight - 2)
  const firstVisibleIndex = Math.max(0, lines.length - visibleLineCount)
  const visibleLines = lines.slice(firstVisibleIndex)
  return (
    <Box flexDirection="column" height={viewportHeight} overflow="hidden">
      <Box
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        flexDirection="column"
        height={inputHeight}
        overflow="hidden"
      >
        {visibleLines.map((line, visibleIndex) => {
          const index = firstVisibleIndex + visibleIndex
          const isLast = index === lines.length - 1
          return (
          <Text key={`${index}:${line}`} wrap={isLast ? 'truncate-start' : 'truncate-end'}>
            <Text color="cyan" bold>{index === 0 ? '› ' : visibleIndex === 0 ? '… ' : '  '}</Text>
            {line || (index === 0 ? <Text dimColor>Type a request or /help…</Text> : '')}
            {isLast ? <Text inverse> </Text> : null}
          </Text>
          )
        })}
      </Box>
      {showSuggestions ? (
        <Text dimColor wrap="truncate-end">Tab: {suggestions.join('   ')}</Text>
      ) : null}
    </Box>
  )
}
