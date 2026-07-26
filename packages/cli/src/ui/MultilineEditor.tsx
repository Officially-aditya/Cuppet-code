import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { COMMAND_COMPLETIONS, type CommandCompletion } from '../commands/dispatcher.js'

type Props = {
  disabled?: boolean
  height?: number
  scrollOffset?: number
  planMode?: boolean
  onSubmit(value: string): void | Promise<void>
  onCompletionChange?(active: boolean): void
  onScrollUp?(): void
  onScrollDown?(): void
  onScrollTop?(): void
  onScrollBottom?(): void
  onScrollLineUp?(): void
  onScrollLineDown?(): void
}

export function MultilineEditor({
  disabled = false,
  height = 4,
  scrollOffset = 0,
  planMode = false,
  onSubmit,
  onCompletionChange,
  onScrollUp,
  onScrollDown,
  onScrollTop,
  onScrollBottom,
  onScrollLineUp,
  onScrollLineDown,
}: Props) {
  const [value, setValue] = useState('')
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [selectedSuggestion, setSelectedSuggestion] = useState(0)
  const [completionDismissed, setCompletionDismissed] = useState(false)
  const history = useRef<string[]>([])
  const viewportHeight = Math.max(1, Math.floor(height))
  const suggestions = useMemo<readonly CommandCompletion[]>(() => {
    if (!value.startsWith('/') || value.includes('\n')) return []
    return COMMAND_COMPLETIONS.filter(({ command }) => command.startsWith(value)).slice(0, 5)
  }, [value])
  const hasExactCommand = suggestions.some(({ command }) => command === value)
  const completionOpen = viewportHeight >= 4 && suggestions.length > 0 && !hasExactCommand && !completionDismissed
  const selectedIndex = Math.min(Math.max(0, selectedSuggestion), Math.max(0, suggestions.length - 1))
  const selectedCompletion = suggestions[selectedIndex]

  useEffect(() => {
    // A newly typed prefix should always start on its first match.
    setSelectedSuggestion(0)
  }, [value])

  useEffect(() => {
    onCompletionChange?.(completionOpen)
    return () => onCompletionChange?.(false)
  }, [completionOpen, onCompletionChange])

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') return

      const keyRecord = key as { home?: boolean; end?: boolean }
      const isHome = keyRecord.home || input === '\u001b[H' || input.includes('\u001b[1~') || input.includes('\u001b[H') || input === '\u001b[1;5H'
      const isEnd = keyRecord.end || input === '\u001b[F' || input.includes('\u001b[4~') || input.includes('\u001b[F') || input === '\u001b[1;5F'
      if (isHome) {
        onScrollTop?.()
        return
      }
      if (isEnd) {
        onScrollBottom?.()
        return
      }

      const isPageUp = key.pageUp || input === '\u0015' || input.includes('\u001b[5~')
      const isPageDown = key.pageDown || input === '\u0004' || input.includes('\u001b[6~')
      if (isPageUp) {
        onScrollUp?.()
        return
      }
      if (isPageDown) {
        onScrollDown?.()
        return
      }

      const isModifierUp = ((key.ctrl || key.shift || key.meta) && key.upArrow) || input === '\u001b[1;2A' || input === '\u001b[1;5A' || input === '\u001b[1;3A'
      const isModifierDown = ((key.ctrl || key.shift || key.meta) && key.downArrow) || input === '\u001b[1;2B' || input === '\u001b[1;5B' || input === '\u001b[1;3B'
      if (isModifierUp) {
        onScrollLineUp?.()
        return
      }
      if (isModifierDown) {
        onScrollLineDown?.()
        return
      }

      if (completionOpen && (key.upArrow || key.downArrow)) {
        const delta = key.downArrow ? 1 : -1
        setSelectedSuggestion((current) => {
          const count = suggestions.length
          return count > 0 ? (current + delta + count) % count : 0
        })
        return
      }

      if (scrollOffset > 0) {
        if (key.upArrow) {
          onScrollLineUp?.()
          return
        }
        if (key.downArrow) {
          onScrollLineDown?.()
          return
        }
      }

      if (key.escape) {
        if (completionOpen) {
          setCompletionDismissed(true)
          return
        }
        setValue('')
        setHistoryIndex(-1)
        setSelectedSuggestion(0)
        setCompletionDismissed(false)
        return
      }
      if (key.return) {
        if (key.ctrl || key.shift) {
          setCompletionDismissed(false)
          setSelectedSuggestion(0)
          setValue((current) => `${current}\n`)
          return
        }
        const submitted = completionOpen && selectedCompletion ? selectedCompletion.command : value.trim()
        if (!submitted) return
        history.current = [...history.current.filter((item) => item !== submitted), submitted].slice(-200)
        setValue('')
        setHistoryIndex(-1)
        setCompletionDismissed(false)
        setSelectedSuggestion(0)
        void onSubmit(submitted)
        return
      }
      if (key.backspace || key.delete) {
        setCompletionDismissed(false)
        setSelectedSuggestion(0)
        setValue((current) => Array.from(current).slice(0, -1).join(''))
        return
      }
      if (key.tab && completionOpen && selectedCompletion) {
        setValue(selectedCompletion.command)
        setHistoryIndex(-1)
        setCompletionDismissed(false)
        setSelectedSuggestion(0)
        return
      }
      if (key.upArrow && !value.includes('\n')) {
        const next = Math.min(history.current.length - 1, historyIndex + 1)
        if (next >= 0) {
          setHistoryIndex(next)
          setCompletionDismissed(false)
          setSelectedSuggestion(0)
          setValue(history.current[history.current.length - 1 - next] ?? '')
        } else if (value === '') {
          onScrollLineUp?.()
        }
        return
      }
      if (key.downArrow && !value.includes('\n')) {
        const next = historyIndex - 1
        setHistoryIndex(next)
        setCompletionDismissed(false)
        setSelectedSuggestion(0)
        setValue(next < 0 ? '' : (history.current[history.current.length - 1 - next] ?? ''))
        return
      }
      if (key.ctrl && input === 'n') {
        setCompletionDismissed(false)
        setSelectedSuggestion(0)
        setValue((current) => `${current}\n`)
        return
      }
      if (input) {
        setCompletionDismissed(false)
        setSelectedSuggestion(0)
        setValue((current) => `${current}${input.replace(/\r\n/g, '\n')}`)
      }
    },
    { isActive: !disabled },
  )

  const lines = value.length > 0 ? value.split('\n') : ['']
  const promptChar = planMode ? 'plan› ' : '› '
  if (viewportHeight < 3) {
    const line = lines.at(-1) ?? ''
    return (
      <Box height={viewportHeight} overflow="hidden">
        <Text wrap="truncate-start">
          <Text color={planMode ? 'yellow' : 'cyan'} bold>{promptChar}</Text>
          {line || <Text dimColor>Type a request…</Text>}
          <Text inverse> </Text>
        </Text>
      </Box>
    )
  }

  const menuRows = completionOpen ? Math.min(suggestions.length, viewportHeight >= 5 ? 2 : 1) : 0
  const inputRowCount = Math.max(1, viewportHeight - 2 - menuRows)
  const firstVisibleIndex = Math.max(0, lines.length - inputRowCount)
  const visibleLines = lines.slice(firstVisibleIndex)
  const firstSuggestionIndex = completionOpen
    ? Math.min(Math.max(0, selectedIndex - menuRows + 1), Math.max(0, suggestions.length - menuRows))
    : 0
  const visibleSuggestions = completionOpen ? suggestions.slice(firstSuggestionIndex, firstSuggestionIndex + menuRows) : []

  return (
    <Box
      borderStyle="single"
      borderColor={planMode ? 'yellow' : 'gray'}
      paddingX={1}
      flexDirection="column"
      height={viewportHeight}
      overflow="hidden"
    >
      {visibleLines.map((line, visibleIndex) => {
        const index = firstVisibleIndex + visibleIndex
        const isLast = index === lines.length - 1
        return (
          <Text key={`${index}:${line}`} wrap={isLast ? 'truncate-start' : 'truncate-end'}>
            <Text color={planMode ? 'yellow' : 'cyan'} bold>{index === 0 ? promptChar : visibleIndex === 0 ? '… ' : '  '}</Text>
            {line || (index === 0 ? <Text dimColor>Type a request or /help…</Text> : '')}
            {isLast ? <Text inverse> </Text> : null}
          </Text>
        )
      })}
      {visibleSuggestions.map((suggestion, index) => {
        const suggestionIndex = firstSuggestionIndex + index
        const selected = suggestionIndex === selectedIndex
        return (
          <Text key={suggestion.command} wrap="truncate-end" dimColor={!selected}>
            <Text color={selected ? 'cyan' : 'gray'} bold={selected}>{selected ? '› ' : '  '}{suggestion.command}</Text>
            <Text dimColor> — {suggestion.description}</Text>
            {selected && suggestions.length > 1 ? <Text dimColor>  {suggestionIndex + 1}/{suggestions.length}</Text> : null}
          </Text>
        )
      })}
    </Box>
  )
}
