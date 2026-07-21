import React, { useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { COMMANDS } from '../commands/dispatcher.js'

type Props = {
  disabled?: boolean
  onSubmit(value: string): void | Promise<void>
}

export function MultilineEditor({ disabled = false, onSubmit }: Props) {
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

  const lines = value.length > 0 ? value.split('\n') : ['']
  return (
    <Box flexDirection="column">
      <Box borderStyle="single" borderColor="gray" paddingX={1} flexDirection="column">
        {lines.map((line, index) => (
          <Text key={`${index}:${line}`}>
            <Text color="cyan" bold>{index === 0 ? '› ' : '  '}</Text>
            {line || (index === 0 ? <Text dimColor>Type a request or /help…</Text> : '')}
            {index === lines.length - 1 ? <Text inverse> </Text> : null}
          </Text>
        ))}
      </Box>
      {suggestions.length > 0 && value !== suggestions[0] ? (
        <Text dimColor>Tab: {suggestions.join('   ')}</Text>
      ) : null}
    </Box>
  )
}
