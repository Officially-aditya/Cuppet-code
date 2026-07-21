import React, { useState, useEffect } from 'react'
import { Box, Text, useApp } from 'ink'
import TextInput from 'ink-text-input'
import SelectInput from 'ink-select-input'
import Spinner from 'ink-spinner'
import type { ProviderAuth } from '../auth/providerAuth.js'
import type { StateMachineEngine } from '../engine/stateMachine.js'
import type { CommandDispatcher } from '../commands/commandDispatcher.js'
import type { ShortTermMemory } from '../tst/stm.js'

type Props = {
  auth: ProviderAuth
  engine: StateMachineEngine
  dispatcher: CommandDispatcher
  stm: ShortTermMemory
}

type MessageItem = {
  id: string
  sender: 'user' | 'assistant' | 'system'
  text: string
}

export const TerminalApp: React.FC<Props> = ({ auth, engine, dispatcher, stm }) => {
  const { exit } = useApp()
  const [messages, setMessages] = useState<MessageItem[]>([
    { id: '1', sender: 'system', text: 'Welcome to Cuppet TST Terminal Agent!' },
  ])
  const [inputVal, setInputVal] = useState('')
  const [loadingStep, setLoadingStep] = useState<string | null>(null)
  const [activeModal, setActiveModal] = useState<'none' | 'login' | 'model'>('none')
  const [notice, setNotice] = useState<string | null>(null)

  const creds = auth.getStore()
  const state = engine.getState()

  useEffect(() => {
    // Show temporary notice timeout
    if (notice) {
      const timer = setTimeout(() => setNotice(null), 5000)
      return () => clearTimeout(timer)
    }
  }, [notice])

  const handleSubmit = async (value: string) => {
    if (!value.trim()) return
    const currentInput = value.trim()
    setInputVal('')

    if (currentInput === 'exit' || currentInput === 'quit') {
      exit()
      return
    }

    // 1. Dispatch slash commands
    const cmdResult = await dispatcher.dispatch(currentInput)
    if (cmdResult.handled) {
      if (cmdResult.action === 'login_prompt') {
        setActiveModal('login')
      } else if (cmdResult.action === 'model_prompt') {
        setActiveModal('model')
      } else if (cmdResult.message) {
        setMessages(prev => [...prev, { id: Date.now().toString(), sender: 'system', text: cmdResult.message! }])
      }
      return
    }

    // 2. Add user message
    setMessages(prev => [...prev, { id: Date.now().toString(), sender: 'user', text: currentInput }])

    // 3. Execute engine turn
    try {
      const response = await engine.executeTurn(currentInput, step => setLoadingStep(step))
      setLoadingStep(null)
      setMessages(prev => [...prev, { id: Date.now().toString(), sender: 'assistant', text: response }])
    } catch (err: any) {
      setLoadingStep(null)
      setMessages(prev => [...prev, { id: Date.now().toString(), sender: 'system', text: `Error: ${err.message}` }])
    }
  }

  const handleSelectLogin = (item: { value: string }) => {
    auth.setProvider(item.value as any)
    setActiveModal('none')
    setNotice(`Provider set to ${item.value}`)
  }

  const handleSelectModel = (item: { value: string }) => {
    auth.setModels(item.value)
    setActiveModal('none')
    setNotice(`Model set to ${item.value}`)
  }

  const loginItems = [
    { label: 'Google Gemini (gemini-3.6-flash)', value: 'google' },
    { label: 'Anthropic Claude (claude-3-7-sonnet)', value: 'anthropic' },
    { label: 'OpenAI (gpt-4o)', value: 'openai' },
  ]

  const modelItems = [
    { label: 'Gemini 3.6 Flash (Primary)', value: 'gemini-3.6-flash' },
    { label: 'Claude 3.7 Sonnet (Primary)', value: 'claude-3-7-sonnet-20250219' },
    { label: 'GPT-4o (Primary)', value: 'gpt-4o' },
  ]

  const totalTokens = state.totalInputTokens + state.totalOutputTokens

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between">
        <Text bold color="cyan">
          CUPPET TST AGENT
        </Text>
        <Text dimColor>
          [{creds.activeProvider.toUpperCase()}] {creds.primaryModel} (Primary) | {creds.secondaryModel} (Secondary)
        </Text>
      </Box>

      {/* Messages Window */}
      <Box flexDirection="column" marginY={1}>
        {messages.slice(-8).map(msg => (
          <Box key={msg.id} marginY={0}>
            {msg.sender === 'user' ? (
              <Text color="green" bold>
                › {msg.text}
              </Text>
            ) : msg.sender === 'assistant' ? (
              <Text color="white">{msg.text}</Text>
            ) : (
              <Text dimColor italic>
                ℹ {msg.text}
              </Text>
            )}
          </Box>
        ))}
      </Box>

      {/* Loading Indicator */}
      {loadingStep && (
        <Box marginY={0}>
          <Text color="yellow">
            <Spinner type="dots" /> {loadingStep}
          </Text>
        </Box>
      )}

      {/* Modal dialogs */}
      {activeModal === 'login' && (
        <Box flexDirection="column" borderStyle="single" borderColor="yellow" padding={1}>
          <Text bold color="yellow">
            Select Provider (/login):
          </Text>
          <SelectInput items={loginItems} onSelect={handleSelectLogin} />
        </Box>
      )}

      {activeModal === 'model' && (
        <Box flexDirection="column" borderStyle="single" borderColor="yellow" padding={1}>
          <Text bold color="yellow">
            Select Primary Model (/model):
          </Text>
          <SelectInput items={modelItems} onSelect={handleSelectModel} />
        </Box>
      )}

      {/* Input Box */}
      {activeModal === 'none' && (
        <Box borderStyle="single" borderColor="gray" paddingX={1}>
          <Text color="cyan" bold>
            ›{' '}
          </Text>
          <TextInput value={inputVal} onChange={setInputVal} onSubmit={handleSubmit} placeholder="Type your message or /help..." />
        </Box>
      )}

      {/* Dynamic Notification Footer */}
      <Box marginTop={1} justifyContent="space-between">
        {notice ? (
          <Text color="yellow">⚠ {notice}</Text>
        ) : (
          <Text dimColor>Token usage: {totalTokens.toLocaleString()} tokens</Text>
        )}
        <Text dimColor>Type /help for commands</Text>
      </Box>
    </Box>
  )
}
