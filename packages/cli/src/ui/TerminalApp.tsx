import React, { useEffect, useMemo, useState } from 'react'
import { Box, Text, useApp, useInput } from 'ink'
import SelectInput from 'ink-select-input'
import TextInput from 'ink-text-input'
import type { CommandAction, CommandDispatcher } from '../commands/dispatcher.js'
import type { ControllerSnapshot, CuppetController } from '../controller.js'
import { PLATFORM_OPTIONS, platformLabel } from '../platforms.js'
import type { AgentEvent, IntegrationInfo, IntegrationMethod, MessageItem, ModelRef, PermissionRequest, Platform, SessionInfo } from '../types.js'
import { MultilineEditor } from './MultilineEditor.js'

type Props = {
  controller: CuppetController
  dispatcher: CommandDispatcher
  initialNotice?: string | undefined
}

type Modal =
  | { type: 'none' }
  | { type: 'platform'; required: boolean }
  | { type: 'model'; role: 'primary' | 'secondary'; required: boolean }
  | { type: 'login-integration'; provider?: string; platform?: Platform; required?: boolean }
  | { type: 'login-method'; integration: IntegrationInfo }
  | { type: 'login-key'; integration: IntegrationInfo }
  | {
      type: 'oauth-prompt'
      integration: IntegrationInfo
      method: Extract<IntegrationMethod, { type: 'oauth' }>
      index: number
      inputs: Record<string, string>
    }
  | { type: 'oauth-wait'; attemptID: string; url: string; instructions: string; mode: 'auto' | 'code' }
  | { type: 'sessions'; sessions: SessionInfo[] }
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'confirm-clear'; scope: 'session' | 'project' | 'global' }
  | { type: 'step-limit'; sessionID: string }

const initialSnapshot: ControllerSnapshot = {
  models: [],
  integrations: [],
  foregroundUsage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  foregroundCost: 0,
  running: false,
  activeTools: 0,
  degraded: true,
  stepCount: 0,
}

export function TerminalApp({ controller, dispatcher, initialNotice }: Props) {
  const { exit } = useApp()
  const [snapshot, setSnapshot] = useState(controller.snapshot ?? initialSnapshot)
  const [messages, setMessages] = useState<MessageItem[]>([
    {
      id: 'welcome',
      sender: 'system',
      text: `Cuppet public alpha${controller.snapshot.degraded ? ' — OpenCode-only degraded mode' : ''}`,
    },
  ])
  const [modal, setModal] = useState<Modal>({ type: 'none' })
  const [notice, setNotice] = useState(initialNotice)
  const [scrollOffset, setScrollOffset] = useState(0)
  const [credential, setCredential] = useState('')
  const [oauthCode, setOAuthCode] = useState('')

  useEffect(() => controller.onChange(setSnapshot), [controller])
  useEffect(
    () => controller.onAgentEvent((event) => handleAgentEvent(event, setMessages, setModal, setNotice)),
    [controller],
  )
  useEffect(() => {
    if (modal.type !== 'none') return
    const next = nextOnboardingModal(controller, snapshot)
    if (next.type !== 'none') {
      if (next.type === 'platform' && snapshot.platform) {
        setNotice(`${platformLabel(snapshot.platform)} has no available models or authentication methods.`)
      }
      setModal(next)
    }
  }, [controller, modal.type, snapshot.integrations.length, snapshot.models.length, snapshot.platform, snapshot.primary, snapshot.secondary])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(undefined), 5_000)
    return () => clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    if (modal.type !== 'oauth-wait' || modal.mode !== 'auto') return
    const timer = setInterval(() => {
      void controller.gateway.oauthStatus(modal.attemptID).then((status) => {
        if (status.status === 'complete') {
          clearInterval(timer)
          void controller.refreshCatalog().then(() => {
            setModal({ type: 'none' })
            setNotice('OAuth connection completed; model catalog refreshed.')
          }).catch((error) => addMessage(setMessages, 'system', `Catalog refresh failed: ${error.message}`))
        } else if (status.status === 'failed' || status.status === 'expired') {
          clearInterval(timer)
          setModal({ type: 'none' })
          addMessage(setMessages, 'system', `OAuth ${status.status}: ${status.message ?? ''}`)
        }
      })
    }, 1_000)
    return () => clearInterval(timer)
  }, [controller.gateway, modal])

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      void controller.denyPendingPermissions().finally(() => exit())
      return
    }
    if (modal.type !== 'none') return
    if (key.pageUp) setScrollOffset((current) => Math.min(messages.length - 1, current + 5))
    if (key.pageDown) setScrollOffset((current) => Math.max(0, current - 5))
  })

  const visibleCount = Math.max(6, (process.stdout.rows ?? 24) - 11)
  const visibleMessages = useMemo(() => {
    const end = Math.max(0, messages.length - scrollOffset)
    return messages.slice(Math.max(0, end - visibleCount), end)
  }, [messages, scrollOffset, visibleCount])
  const tokenCount = snapshot.foregroundUsage.input + snapshot.foregroundUsage.output + snapshot.foregroundUsage.reasoning

  const submit = async (value: string) => {
    if (value === 'exit' || value === 'quit') {
      exit()
      return
    }
    if (snapshot.running && !value.startsWith('/')) {
      addMessage(setMessages, 'system', 'A turn is active. Use /steer <instruction> or /steer --interrupt <instruction>.')
      return
    }
    try {
      const result = await dispatcher.dispatch(value)
      if (result.handled) {
        if (result.message) addMessage(setMessages, 'system', result.message)
        if (result.action) await openAction(result.action, controller, setModal, setMessages)
        return
      }
      addMessage(setMessages, 'user', value)
      await controller.submit(value)
    } catch (error) {
      addMessage(setMessages, 'system', `Error: ${(error as Error).message}`)
    }
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} justifyContent="space-between">
        <Text bold color="cyan">CUPPET</Text>
        <Text dimColor>
          {snapshot.platform ? `${platformLabel(snapshot.platform)} · ` : ''}{modelLabel(snapshot.primary)} → {modelLabel(snapshot.secondary)}{snapshot.degraded ? '  [TST degraded]' : ''}
        </Text>
      </Box>

      <Box flexDirection="column" minHeight={visibleCount}>
        {visibleMessages.map((message) => (
          <Message key={message.id} item={message} />
        ))}
      </Box>

      {modal.type === 'none' ? <MultilineEditor onSubmit={submit} /> : null}
      <ModalView
        modal={modal}
        snapshot={snapshot}
        controller={controller}
        credential={credential}
        setCredential={setCredential}
        oauthCode={oauthCode}
        setOAuthCode={setOAuthCode}
        setModal={setModal}
        setMessages={setMessages}
        setNotice={setNotice}
      />

      <Box justifyContent="space-between">
        <Text {...(notice ? { color: 'yellow' as const } : { dimColor: true })}>
          {notice ?? `Token usage: ${tokenCount.toLocaleString()}`}
        </Text>
        <Text dimColor>
          {snapshot.running ? `step ${snapshot.stepCount}/64 · tools ${snapshot.activeTools}` : 'Ctrl+N newline · PgUp/PgDn scroll'}
        </Text>
      </Box>
    </Box>
  )
}

function ModalView(props: {
  modal: Modal
  snapshot: ControllerSnapshot
  controller: CuppetController
  credential: string
  setCredential(value: string): void
  oauthCode: string
  setOAuthCode(value: string): void
  setModal(value: Modal): void
  setMessages: React.Dispatch<React.SetStateAction<MessageItem[]>>
  setNotice(value: string | undefined): void
}) {
  const { modal, controller, snapshot } = props
  if (modal.type === 'none') return null

  if (modal.type === 'platform') {
    return (
      <ModalBox title={`Select platform${modal.required ? ' (required)' : ''}`}>
        <SelectInput
          items={PLATFORM_OPTIONS.map((option) => ({
            label: `${option.label} · ${option.description}`,
            value: option.value,
          }))}
          onSelect={(item) => {
            const platform = item.value as Platform
            void controller
              .selectPlatform(platform)
              .then(() => {
                const next = nextOnboardingModal(controller, controller.snapshot)
                if (next.type === 'platform') {
                  props.setNotice(`${platformLabel(platform)} has no available models or authentication methods.`)
                }
                props.setModal(next)
              })
              .catch((error) => addMessage(props.setMessages, 'system', `Platform error: ${error.message}`))
          }}
        />
      </ModalBox>
    )
  }

  if (modal.type === 'model') {
    const recommended = modal.role === 'secondary' ? controller.recommendedSecondary() : undefined
    const models = controller.modelsForPlatform(snapshot.platform).sort((left, right) => {
      const leftRecommended = recommended && sameModel(left, recommended) ? -1 : 0
      const rightRecommended = recommended && sameModel(right, recommended) ? -1 : 0
      return leftRecommended - rightRecommended || left.name.localeCompare(right.name)
    })
    return (
      <ModalBox title={`Select ${modal.role} model${modal.required ? ' (required)' : ''}`}>
        <SelectInput
          items={models.map((model) => ({
            label: `${model.name} · ${model.providerID}${recommended && sameModel(model, recommended) ? ' (recommended)' : ''}`,
            value: `${model.providerID}\u0000${model.modelID}\u0000${model.variant ?? ''}`,
          }))}
          onSelect={(item) => {
            const [providerID = '', modelID = '', variant = ''] = item.value.split('\u0000')
            void controller
              .selectModel(modal.role, { providerID, modelID, ...(variant ? { variant } : {}) })
              .then(() => {
                if (modal.role === 'primary' && !snapshot.secondary) {
                  props.setModal({ type: 'model', role: 'secondary', required: true })
                } else props.setModal({ type: 'none' })
              })
              .catch((error) => addMessage(props.setMessages, 'system', `Model error: ${error.message}`))
          }}
        />
      </ModalBox>
    )
  }

  if (modal.type === 'login-integration') {
    const provider = modal.provider?.toLowerCase()
    const integrations = modal.platform
      ? controller.integrationsForPlatform(modal.platform)
      : snapshot.integrations.filter((item) =>
          provider ? item.id.toLowerCase().includes(provider) || item.name.toLowerCase().includes(provider) : true,
        )
    return (
      <ModalBox title="Connect provider (credentials stay in OpenCode)">
        <SelectInput
          items={[
            ...integrations.map((item) => ({ label: `${item.name}${item.connections.length ? ' · connected' : ''}`, value: item.id })),
            { label: 'Cancel', value: '__cancel' },
          ]}
          onSelect={(item) => {
            if (item.value === '__cancel') {
              return props.setModal(modal.required ? { type: 'platform', required: true } : { type: 'none' })
            }
            const integration = integrations.find((candidate) => candidate.id === item.value)
            if (integration) props.setModal({ type: 'login-method', integration })
          }}
        />
      </ModalBox>
    )
  }

  if (modal.type === 'login-method') {
    return (
      <ModalBox title={`${modal.integration.name}: authentication method`}>
        <SelectInput
          items={modal.integration.methods.map((method, index) => ({
            label: method.type === 'env' ? `Environment (${method.names.join(', ')})` : (method.label ?? method.type),
            value: String(index),
          }))}
          onSelect={(item) => {
            const method = modal.integration.methods[Number(item.value)]
            if (!method) return
            if (method.type === 'key') props.setModal({ type: 'login-key', integration: modal.integration })
            else if (method.type === 'env') {
              props.setNotice(`Environment method: set ${method.names.join(' or ')} before launch.`)
              props.setModal({ type: 'none' })
            } else {
              const prompts = method.prompts ?? []
              const firstPrompt = nextPromptIndex(prompts, 0, {})
              if (firstPrompt >= 0) {
                props.setModal({ type: 'oauth-prompt', integration: modal.integration, method, index: firstPrompt, inputs: {} })
              } else void beginOAuth(controller, modal.integration, method, {}, props)
            }
          }}
        />
      </ModalBox>
    )
  }

  if (modal.type === 'login-key') {
    return (
      <ModalBox title={`${modal.integration.name}: API key`}>
        <Text>The key is sent directly to OpenCode and never enters prompt history.</Text>
        <TextInput
          value={props.credential}
          onChange={props.setCredential}
          mask="*"
          onSubmit={(value) => {
            props.setCredential('')
            void controller.gateway
              .connectKey(modal.integration.id, value)
              .then(() => controller.refreshCatalog())
              .then(() => {
                props.setNotice(`${modal.integration.name} connected; model catalog refreshed.`)
                props.setModal({ type: 'none' })
              })
              .catch((error) => addMessage(props.setMessages, 'system', `Login failed: ${error.message}`))
          }}
        />
      </ModalBox>
    )
  }

  if (modal.type === 'oauth-prompt') {
    const prompt = modal.method.prompts?.[modal.index]
    if (!prompt) {
      void beginOAuth(controller, modal.integration, modal.method, modal.inputs, props)
      return null
    }
    const advance = (value: string) => {
      const inputs = { ...modal.inputs, [prompt.key]: value }
      const next = nextPromptIndex(modal.method.prompts ?? [], modal.index + 1, inputs)
      if (next < 0) void beginOAuth(controller, modal.integration, modal.method, inputs, props)
      else props.setModal({ ...modal, index: next, inputs })
    }
    return (
      <ModalBox title={prompt.message}>
        {prompt.type === 'select' ? (
          <SelectInput items={prompt.options.map((item) => ({ label: item.label, value: item.value }))} onSelect={(item) => advance(item.value)} />
        ) : (
          <TextInput value={props.oauthCode} onChange={props.setOAuthCode} onSubmit={(value) => { props.setOAuthCode(''); advance(value) }} />
        )}
      </ModalBox>
    )
  }

  if (modal.type === 'oauth-wait') {
    return (
      <ModalBox title="Complete OAuth in your browser">
        <Text color="cyan">{modal.url}</Text>
        <Text>{modal.instructions}</Text>
        {modal.mode === 'code' ? (
          <TextInput
            value={props.oauthCode}
            onChange={props.setOAuthCode}
            onSubmit={(code) => {
              props.setOAuthCode('')
              void controller.gateway
                .completeOAuth(modal.attemptID, code)
                .then(() => controller.refreshCatalog())
                .then(() => { props.setNotice('OAuth connection completed; model catalog refreshed.'); props.setModal({ type: 'none' }) })
                .catch((error) => addMessage(props.setMessages, 'system', `OAuth failed: ${error.message}`))
            }}
          />
        ) : <Text dimColor>Waiting for callback…</Text>}
      </ModalBox>
    )
  }

  if (modal.type === 'sessions') {
    return (
      <ModalBox title="Resume project session">
        <SelectInput
          items={[...modal.sessions.map((session) => ({ label: `${session.title} · ${new Date(session.updated).toLocaleString()}`, value: session.id })), { label: 'Cancel', value: '__cancel' }]}
          onSelect={(item) => {
            if (item.value === '__cancel') return props.setModal({ type: 'none' })
            void controller.resume(item.value).then(() => props.setModal({ type: 'none' }))
          }}
        />
      </ModalBox>
    )
  }

  if (modal.type === 'permission') {
    return (
      <ModalBox title={`Permission: ${modal.request.action}`}>
        <Text>{modal.request.resources.join('\n')}</Text>
        <SelectInput
          items={[
            { label: 'Allow once', value: 'once' },
            { label: 'Allow for session', value: 'always' },
            { label: 'Deny', value: 'reject' },
          ]}
          onSelect={(item) => {
            void controller.replyPermission(modal.request, item.value as 'once' | 'always' | 'reject').finally(() => props.setModal({ type: 'none' }))
          }}
        />
      </ModalBox>
    )
  }

  if (modal.type === 'confirm-clear') {
    return (
      <ModalBox title={`Clear ${modal.scope} memory?`}>
        <SelectInput
          items={[{ label: 'Cancel', value: 'no' }, { label: 'Clear permanently', value: 'yes' }]}
          onSelect={(item) => {
            if (item.value === 'no') return props.setModal({ type: 'none' })
            void controller.clearMemory(modal.scope).then((count) => props.setNotice(`Cleared ${count} record(s).`)).finally(() => props.setModal({ type: 'none' }))
          }}
        />
      </ModalBox>
    )
  }

  return (
    <ModalBox title="64-step ceiling reached">
      <Text>The active tool completed. Start a fresh 64-step continuation?</Text>
      <SelectInput
        items={[{ label: 'Stop', value: 'stop' }, { label: 'Continue', value: 'continue' }]}
        onSelect={(item) => {
          props.setModal({ type: 'none' })
          if (item.value === 'continue') void controller.submit('Continue from the current verified state.')
        }}
      />
    </ModalBox>
  )
}

function ModalBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">{title}</Text>
      {children}
    </Box>
  )
}

function Message({ item }: { item: MessageItem }) {
  const color = item.sender === 'user' ? 'green' : item.sender === 'system' ? 'yellow' : item.sender === 'tool' ? 'cyan' : undefined
  const prefix = item.sender === 'user' ? '› ' : item.sender === 'tool' ? '⚙ ' : item.sender === 'system' ? 'ℹ ' : ''
  return <Text {...(color ? { color } : {})} dimColor={item.sender === 'reasoning'}>{prefix}{item.text}</Text>
}

async function openAction(
  action: CommandAction,
  controller: CuppetController,
  setModal: (modal: Modal) => void,
  setMessages: React.Dispatch<React.SetStateAction<MessageItem[]>>,
) {
  if (action.type === 'platform') setModal({ type: 'platform', required: false })
  else if (action.type === 'model') {
    const snapshot = controller.snapshot
    if (!snapshot.platform) setModal({ type: 'platform', required: true })
    else if (controller.modelsForPlatform(snapshot.platform).length === 0) {
      setModal({ type: 'login-integration', platform: snapshot.platform, required: true })
    } else setModal({ type: 'model', role: action.role, required: false })
  }
  else if (action.type === 'login') setModal({ type: 'login-integration', ...(action.provider ? { provider: action.provider } : {}) })
  else if (action.type === 'confirm-clear') setModal(action)
  else {
    try {
      setModal({ type: 'sessions', sessions: await controller.listSessions() })
    } catch (error) {
      addMessage(setMessages, 'system', `Unable to list sessions: ${(error as Error).message}`)
    }
  }
}

async function beginOAuth(
  controller: CuppetController,
  integration: IntegrationInfo,
  method: Extract<IntegrationMethod, { type: 'oauth' }>,
  inputs: Record<string, string>,
  props: { setModal(value: Modal): void; setMessages: React.Dispatch<React.SetStateAction<MessageItem[]>> },
) {
  try {
    const attempt = await controller.gateway.beginOAuth(integration.id, method.id, inputs)
    props.setModal({ type: 'oauth-wait', ...attempt })
  } catch (error) {
    addMessage(props.setMessages, 'system', `OAuth failed: ${(error as Error).message}`)
    props.setModal({ type: 'none' })
  }
}

function handleAgentEvent(
  event: AgentEvent,
  setMessages: React.Dispatch<React.SetStateAction<MessageItem[]>>,
  setModal: (modal: Modal) => void,
  setNotice: (notice: string | undefined) => void,
) {
  if (event.type === 'text-delta') appendStream(setMessages, 'assistant', `assistant:${event.sessionID}`, event.text)
  else if (event.type === 'reasoning-delta') appendStream(setMessages, 'reasoning', `reasoning:${event.sessionID}`, event.text)
  else if (event.type === 'tool-start') addMessage(setMessages, 'tool', `${event.name} started`, `tool:${event.callID}`)
  else if (event.type === 'tool-progress') appendStream(setMessages, 'tool', `tool:${event.callID}`, `\n${event.message}`)
  else if (event.type === 'tool-end') appendStream(setMessages, 'tool', `tool:${event.callID}`, `\n${event.success ? 'completed' : 'failed'}`)
  else if (event.type === 'diff') addMessage(setMessages, 'tool', `Diff\n${JSON.stringify(event.diff, null, 2)}`)
  else if (event.type === 'permission') setModal({ type: 'permission', request: event.request })
  else if (event.type === 'compaction') setNotice(`Conversation compaction ${event.phase}.`)
  else if (event.type === 'error') addMessage(setMessages, 'system', `OpenCode: ${event.message}`)
  else if (event.type === 'step-limit') setModal({ type: 'step-limit', sessionID: event.sessionID })
  else if (event.type === 'tst-notification') {
    if (event.method === 'indexing.progress') {
      const progress = event.params as { indexed?: number; discovered?: number }
      setNotice(`Indexing code graph: ${progress.indexed ?? 0}/${progress.discovered ?? '?'}`)
    } else if (event.method === 'indexing.complete') setNotice('Code graph indexing complete.')
    else if (event.method === 'graph.changed') setNotice('Code graph updated.')
    else if (event.method === 'health') {
      const health = event.params as { recovery_warnings?: unknown[] }
      if (health.recovery_warnings?.length) setNotice('TST recovered storage with warnings; run /status.')
    }
  }
}

function addMessage(
  setMessages: React.Dispatch<React.SetStateAction<MessageItem[]>>,
  sender: MessageItem['sender'],
  text: string,
  id = `${Date.now()}:${Math.random()}`,
) {
  setMessages((current) => [...current, { id, sender, text }])
}

function appendStream(
  setMessages: React.Dispatch<React.SetStateAction<MessageItem[]>>,
  sender: MessageItem['sender'],
  id: string,
  delta: string,
) {
  setMessages((current) => {
    const index = current.findIndex((item) => item.id === id)
    if (index < 0) return [...current, { id, sender, text: delta }]
    return current.map((item, itemIndex) => itemIndex === index ? { ...item, text: `${item.text}${delta}` } : item)
  })
}

function modelLabel(model?: ModelRef): string {
  return model ? `${model.providerID}/${model.modelID}${model.variant ? `@${model.variant}` : ''}` : 'not selected'
}

function sameModel(left: ModelRef, right: ModelRef): boolean {
  return left.providerID === right.providerID && left.modelID === right.modelID && left.variant === right.variant
}

function nextOnboardingModal(controller: CuppetController, snapshot: ControllerSnapshot): Modal {
  if (!snapshot.platform) return { type: 'platform', required: true }
  if (!snapshot.primary) {
    if (controller.modelsForPlatform(snapshot.platform).length > 0) {
      return { type: 'model', role: 'primary', required: true }
    }
    if (controller.integrationsForPlatform(snapshot.platform).length > 0) {
      return {
        type: 'login-integration',
        platform: snapshot.platform,
        required: true,
      }
    }
    return { type: 'platform', required: true }
  }
  if (!snapshot.secondary) return { type: 'model', role: 'secondary', required: true }
  return { type: 'none' }
}

function nextPromptIndex(
  prompts: NonNullable<Extract<IntegrationMethod, { type: 'oauth' }>['prompts']>,
  start: number,
  inputs: Record<string, string>,
): number {
  for (let index = start; index < prompts.length; index += 1) {
    const condition = prompts[index]?.when
    if (!condition) return index
    const equal = inputs[condition.key] === condition.value
    if ((condition.op === 'eq' && equal) || (condition.op === 'neq' && !equal)) return index
  }
  return -1
}
