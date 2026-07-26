import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink'
import SelectInput from 'ink-select-input'
import TextInput from 'ink-text-input'
import type { CommandAction, CommandDispatcher } from '../commands/dispatcher.js'
import type { ControllerSnapshot, CuppetController } from '../controller.js'
import { PLATFORM_OPTIONS, platformLabel } from '../platforms.js'
import type { AgentEvent, IntegrationInfo, IntegrationMethod, MessageItem, ModelInfo, ModelRef, PermissionRequest, Platform, SessionInfo, TokenUsage } from '../types.js'
import { formatTokenCount, totalTokenUsage } from '../usage.js'
import { MultilineEditor } from './MultilineEditor.js'
import { nextPermissionModal, previousModal, type Modal } from './modal.js'
import { renderMessageLines, viewportLayout, windowMessageLines, type MessageLine } from './viewport.js'

type Props = {
  controller: CuppetController
  dispatcher: CommandDispatcher
  initialNotice?: string | undefined
}

const initialSnapshot: ControllerSnapshot = {
  models: [],
  integrations: [],
  foregroundUsage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  foregroundCost: 0,
  running: false,
  planMode: false,
  activeTools: 0,
  degraded: true,
  stepCount: 0,
  vertex: {
    adc: { available: false, source: 'none', explicitUnavailable: false },
    project: { configured: false, source: 'provider-adc' },
    location: { value: 'global', source: 'cuppet-default' },
  },
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active) {
      setFrame(0)
      return
    }
    const timer = setInterval(() => {
      setFrame((current) => (current + 1) % SPINNER_FRAMES.length)
    }, 150)
    return () => clearInterval(timer)
  }, [active])
  return SPINNER_FRAMES[frame] ?? '⠋'
}

function useTerminalSize(stdout: NodeJS.WriteStream): { columns: number; rows: number } {
  const read = () => ({
    columns: Math.max(1, stdout.columns || 80),
    rows: Math.max(1, stdout.rows || 24),
  })
  const [size, setSize] = useState(read)
  useEffect(() => {
    const update = () => {
      const next = read()
      setSize((current) => current.columns === next.columns && current.rows === next.rows ? current : next)
    }
    stdout.on('resize', update)
    update()
    return () => {
      stdout.off('resize', update)
    }
  }, [stdout])
  return size
}

export function TerminalApp({ controller, dispatcher, initialNotice }: Props) {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const terminal = useTerminalSize(stdout)
  const [snapshot, setSnapshot] = useState(controller.snapshot ?? initialSnapshot)
  const [messages, setMessages] = useState<MessageItem[]>([])
  const [modal, setModal] = useState<Modal>({ type: 'none' })
  const [notice, setNotice] = useState(initialNotice)
  const [committedLineCount, setCommittedLineCount] = useState(0)
  const [completionFocused, setCompletionFocused] = useState(false)
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

  const layout = viewportLayout(terminal.rows, modal.type !== 'none')
  const horizontalPadding = terminal.columns > 4 ? 1 : 0
  const contentColumns = Math.max(1, terminal.columns - horizontalPadding * 2)
  const allMessageLines = useMemo(
    () => renderMessageLines(messages, contentColumns),
    [contentColumns, messages],
  )
  // Keep the newest lines directly above the composer. Older lines are emitted
  // once to native terminal scrollback. Never split a short transcript merely
  // because an agent changed phases; that creates a blank band in the middle.
  const targetCommittedLineCount = Math.max(
    committedLineCount,
    Math.max(0, allMessageLines.length - layout.messages),
  )
  const staticLineCount = Math.min(allMessageLines.length, targetCommittedLineCount)
  const staticLines = useMemo(
    () => allMessageLines.slice(0, staticLineCount),
    [allMessageLines, staticLineCount],
  )
  const liveMessageLines = useMemo(
    () => allMessageLines.slice(staticLineCount),
    [allMessageLines, staticLineCount],
  )
  const messageWindow = useMemo(
    () => windowMessageLines(liveMessageLines, layout.messages, 0),
    [layout.messages, liveMessageLines],
  )
  useLayoutEffect(() => {
    setCommittedLineCount((current) => Math.max(current, targetCommittedLineCount))
  }, [targetCommittedLineCount])

  const handleCompletionChange = useCallback((active: boolean) => {
    setCompletionFocused(active)
  }, [])

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      void controller.denyPendingPermissions().finally(() => exit())
      return
    }
    if (key.escape && modal.type !== 'none') {
      const current = modal
      setCredential('')
      setOAuthCode('')
      if (current.type === 'permission') {
        setModal(nextPermissionModal(current))
      } else {
        setModal(previousModal(current))
      }
      if (current.type === 'oauth-wait') {
        void controller.gateway
          .cancelOAuth(current.attemptID)
          .then(() => setNotice('OAuth sign-in cancelled.'))
          .catch((error) => addMessage(setMessages, 'system', `OAuth cancellation failed: ${error.message}`))
      } else if (current.type === 'permission') {
        void controller
          .replyPermission(current.request, 'reject')
          .catch((error) => addMessage(setMessages, 'system', `Permission denial failed: ${error.message}`))
      }
      return
    }
    if (key.escape && completionFocused) return
    if (key.escape && snapshot.running) {
      void controller
        .abort()
        .then(() => {
          setNotice('Ongoing message interrupted.')
          addMessage(setMessages, 'system', 'Interrupted ongoing message.')
        })
        .catch((error) => addMessage(setMessages, 'system', `Interrupt failed: ${(error as Error).message}`))
      return
    }
    if (modal.type !== 'none') return
    if (completionFocused && (key.upArrow || key.downArrow)) return
  })

  const tokenCount = totalTokenUsage(snapshot.foregroundUsage)
  const spinner = useSpinner(snapshot.running)

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
      activeTurnSegment += 1
      addMessage(setMessages, 'user', value)
      await controller.submit(value)
    } catch (error) {
      addMessage(setMessages, 'system', `Error: ${(error as Error).message}`)
    }
  }

  if (layout.rows === 0) return null

  return (
    <>
      <Static items={staticLines}>
        {(line) => (
          <Box key={line.id} flexDirection="column" paddingX={horizontalPadding}>
            <Message item={line} />
          </Box>
        )}
      </Static>

      <Box
        flexDirection="column"
        justifyContent="flex-end"
        height={layout.rows}
        overflow="hidden"
        paddingX={horizontalPadding}
      >
        {modal.type === 'none' && messageWindow.lines.length > 0 ? (
          <Box flexDirection="column" justifyContent="flex-end" height={layout.messages} overflow="hidden" flexShrink={0}>
            {messageWindow.lines.map((line) => (
              <Message key={line.id} item={line} />
            ))}
          </Box>
        ) : null}

        {modal.type === 'none' && layout.header > 0 ? (
          <Box height={1} overflow="hidden" flexShrink={0}>
            <Text wrap="truncate-end">
              <Text bold color="cyan">CUPPET</Text>
              <Text dimColor> · {modelLabel(snapshot.primary)}</Text>
              {snapshot.planMode ? <Text color="yellow"> · plan</Text> : null}
              {snapshot.running ? <Text color="yellow"> · {spinner} working</Text> : null}
              {snapshot.degraded ? <Text dimColor> · degraded</Text> : null}
            </Text>
          </Box>
        ) : null}

        {modal.type === 'none' && layout.editor > 0 ? (
          <MultilineEditor
            height={layout.editor}
            planMode={snapshot.planMode}
            onSubmit={submit}
            onCompletionChange={handleCompletionChange}
          />
        ) : null}
        {modal.type !== 'none' && layout.modal > 0 ? (
          <ModalView
            height={layout.modal}
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
        ) : null}

        {layout.footer > 0 ? (
          <Box height={1} overflow="hidden" flexShrink={0}>
            <Text {...(notice || snapshot.running ? { color: 'yellow' as const } : { dimColor: true })} wrap="truncate-end">
              {notice ?? `Tokens ${formatTokenCount(tokenCount)}`} · {modal.type !== 'none'
                ? 'Esc back · ↑↓ select · Enter confirm'
                : completionFocused
                  ? '↑↓ choose · Tab complete · Enter run · Esc dismiss'
                  : snapshot.running
                    ? `${spinner} working · step ${snapshot.stepCount}/64 · ${snapshot.activeTools} tools`
                    : 'Ctrl+N newline · /help'}
            </Text>
          </Box>
        ) : null}
      </Box>
    </>
  )
}

function ModalView(props: {
  height: number
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
  const listLimit = Math.max(1, props.height - 3)

  if (modal.type === 'status') {
    const data = modal.data
    const platform = String(data.platform ?? 'Not selected')
    const primary = data.primary ? modelLabel(data.primary as ModelRef) : 'Not selected'
    const session = data.session as SessionInfo | undefined
    const foreground = data.foreground as { usage?: TokenUsage; cost?: number; running?: boolean; steps?: number } | undefined
    const usage = foreground?.usage ?? { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    const totalTokens = totalTokenUsage(usage)
    const tst = data.tst as { graph?: { files?: number; symbols?: number }; mode?: string } | undefined
    const background = data.background as {
      paused?: boolean
      running?: boolean
      queued?: number
      deferred?: number
      attempts?: number
      cancellations?: number
    } | undefined

    return (
      <ModalBox height={props.height} title="System & Session Status">
        <Box flexDirection="column" paddingX={0}>
          <Text wrap="truncate-end">
            <Text color="cyan" bold>Platform: </Text>{platform}  │
            <Text color="cyan" bold> Model: </Text>{primary}
          </Text>
          <Text wrap="truncate-end">
            <Text color="cyan" bold>Session: </Text>{session?.title ?? 'Active'} ({session?.id ?? 'n/a'})
          </Text>
          <Text wrap="truncate-end">
            <Text color="green" bold>Token Usage: </Text>
            Total: {totalTokens.toLocaleString()} │ Input: {usage.input.toLocaleString()} │ Output: {usage.output.toLocaleString()} │ Thinking: {usage.reasoning.toLocaleString()}
          </Text>
          <Text wrap="truncate-end">
            <Text color="green" bold>Cache: </Text>
            Read: {usage.cacheRead.toLocaleString()} │ Write: {usage.cacheWrite.toLocaleString()}
          </Text>
          {tst?.graph ? (
            <Text wrap="truncate-end">
              <Text color="yellow" bold>Code Graph: </Text>
              Files: {tst.graph.files ?? 0} │ Symbols: {tst.graph.symbols ?? 0}
            </Text>
          ) : null}
          {background ? (
            <Text wrap="truncate-end">
              <Text color="magenta" bold>Background: </Text>
              {background.paused ? 'paused' : background.running ? 'running' : 'idle'} │ Pending: {background.queued ?? 0} │ Deferred: {background.deferred ?? 0} │ Attempts: {background.attempts ?? 0} │ Cancelled: {background.cancellations ?? 0}
            </Text>
          ) : null}
        </Box>

        <Box marginTop={1}>
          <SelectInput
            limit={Math.max(1, listLimit - 5)}
            items={[
              { label: 'Close Status (Esc)', value: 'close' },
              { label: 'Compact Memory & History (/compact)', value: 'compact' },
              { label: 'Select Primary Model (/model primary)', value: 'model-primary' },
              { label: 'Pause/Resume Background (/background)', value: 'background' },
            ]}
            onSelect={(item) => {
              if (item.value === 'close') {
                props.setModal({ type: 'none' })
              } else if (item.value === 'compact') {
                props.setModal({ type: 'none' })
                void controller.compact().then(() => props.setNotice('Memory & history compacted.'))
              } else if (item.value === 'model-primary') {
                props.setModal({ type: 'model', role: 'primary', required: false })
              } else if (item.value === 'background') {
                props.setModal({ type: 'none' })
                const isPaused = Boolean(snapshot.background?.paused)
                void controller.setBackgroundPaused(!isPaused).then(() => props.setNotice(`Background ${!isPaused ? 'paused' : 'resumed'}.`))
              }
            }}
          />
        </Box>
      </ModalBox>
    )
  }

  if (modal.type === 'platform') {
    return (
      <ModalBox height={props.height} title={`Select platform${modal.required ? ' (required)' : ''}`}>
        <SelectInput
          limit={listLimit}
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

  if (modal.type === 'vertex-setup') {
    const adc = snapshot.vertex.adc
    const project = snapshot.vertex.project
    const location = snapshot.vertex.location
    return (
      <ModalBox height={props.height} title="Vertex AI ADC setup">
        <Text color={adc.available ? 'green' : 'yellow'}>
          ADC: {adc.available ? `detected (${adc.source})` : 'not detected'}
        </Text>
        <Text wrap="truncate-end">
          Project: {project.configured ? `configured via ${project.source}` : 'resolved by Google ADC'}
        </Text>
        <Text wrap="truncate-end">Location: {location.value} ({location.source})</Text>
        {adc.explicitUnavailable ? (
          <Text color="red">GOOGLE_APPLICATION_CREDENTIALS points to an unreadable file.</Text>
        ) : null}
        {!adc.available ? (
          <>
            <Text>Run: gcloud auth application-default login</Text>
            <Text>Optional: export GOOGLE_CLOUD_PROJECT=&lt;project-id&gt;</Text>
            <Text>Optional override: export GOOGLE_VERTEX_LOCATION=&lt;region&gt;</Text>
            <Text dimColor>Restart Cuppet after creating ADC.</Text>
          </>
        ) : (
          <Text color="yellow">ADC was detected, but OpenCode exposed no compatible Vertex models. Run /doctor for provider details.</Text>
        )}
        <Text dimColor>Esc returns to the previous screen.</Text>
      </ModalBox>
    )
  }

  if (modal.type === 'model') {
    const recommended = modal.role === 'secondary' ? controller.recommendedSecondary() : undefined
    const choices = modelPickerChoices(controller.modelsForPlatform(snapshot.platform, modal.role)).sort((left, right) => {
      const leftRecommended = recommended && sameModelFamily(left.model, recommended) ? -1 : 0
      const rightRecommended = recommended && sameModelFamily(right.model, recommended) ? -1 : 0
      return leftRecommended - rightRecommended || left.name.localeCompare(right.name)
    })
    return (
      <ModalBox height={props.height} title={`Select ${modal.role} model${modal.required ? ' (required)' : ''}`}>
        <SelectInput
          limit={listLimit}
          items={choices.map((choice) => ({
            label: `${choice.name} · ${choice.model.providerID}${recommended && sameModelFamily(choice.model, recommended) ? ' (recommended)' : ''}`,
            value: modelPickerValue(choice.model),
          }))}
          onSelect={(item) => {
            const choice = choices.find((candidate) => modelPickerValue(candidate.model) === item.value)
            if (!choice) return
            if (choice.efforts.length > 0) {
              props.setModal({
                type: 'effort',
                role: modal.role,
                options: choice.efforts,
                model: choice.model,
                returnToModel: true,
                required: modal.required,
              })
              return
            }
            void controller
              .selectModel(modal.role, choice.model)
              .then(() => {
                props.setModal(nextModelSelectionModal(modal.role, snapshot))
              })
              .catch((error) => addMessage(props.setMessages, 'system', `Model error: ${error.message}`))
          }}
        />
      </ModalBox>
    )
  }

  if (modal.type === 'effort') {
    const selected = modal.model ?? (modal.role === 'primary' ? snapshot.primary : snapshot.secondary)
    return (
      <ModalBox height={props.height} title={`Select ${modal.role} effort for ${selected ? `${selected.providerID}/${selected.modelID}` : 'model'}`}>
        <SelectInput
          limit={listLimit}
          items={modal.options.map((effort) => ({
            label: `${effort}${!modal.model && selected?.variant === effort ? ' (current)' : ''}`,
            value: effort,
          }))}
          onSelect={(item) => {
            const selection: Promise<string> = modal.model
              ? controller
                .selectModel(modal.role, { ...modal.model, variant: item.value })
                .then(() => item.value)
              : controller.selectEffort(modal.role, item.value)
            void selection
              .then((effort) => {
                props.setNotice(`${capitalize(modal.role)} effort set to ${effort}.`)
                props.setModal(modal.model ? nextModelSelectionModal(modal.role, snapshot) : { type: 'none' })
              })
              .catch((error) => addMessage(props.setMessages, 'system', `Effort error: ${error.message}`))
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
      <ModalBox height={props.height} title="Connect provider (credentials stay in OpenCode)">
        <SelectInput
          limit={listLimit}
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
      <ModalBox height={props.height} title={`${modal.integration.name}: authentication method`}>
        <SelectInput
          limit={listLimit}
          items={modal.integration.methods.map((method, index) => ({
            label: method.type === 'env' ? `Environment (${method.names.join(', ')})` : (method.label ?? method.type),
            value: String(index),
          }))}
          onSelect={(item) => {
            const method = modal.integration.methods[Number(item.value)]
            if (!method) return
            if (method.type === 'key') {
              const prompts = method.prompts ?? []
              const firstPrompt = nextPromptIndex(prompts, 0, {})
              if (firstPrompt >= 0) {
                props.setModal({
                  type: 'key-prompt',
                  integration: modal.integration,
                  method,
                  index: firstPrompt,
                  inputs: {},
                })
              } else props.setModal({ type: 'login-key', integration: modal.integration, method })
            }
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
      <ModalBox height={props.height} title={`${modal.integration.name}: API key`}>
        <Text wrap="truncate-end">The key is sent directly to OpenCode and never enters prompt history.</Text>
        <TextInput
          value={props.credential}
          onChange={props.setCredential}
          mask="*"
          onSubmit={(value) => {
            props.setCredential('')
            void controller.gateway
              .connectKey(modal.integration.id, value, modal.metadata)
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

  if (modal.type === 'key-prompt') {
    const prompt = modal.method.prompts?.[modal.index]
    if (!prompt) {
      props.setModal({
        type: 'login-key',
        integration: modal.integration,
        method: modal.method,
        metadata: modal.inputs,
      })
      return null
    }
    const advance = (value: string) => {
      const inputs = { ...modal.inputs, [prompt.key]: value }
      const next = nextPromptIndex(modal.method.prompts ?? [], modal.index + 1, inputs)
      if (next < 0) {
        props.setModal({
          type: 'login-key',
          integration: modal.integration,
          method: modal.method,
          metadata: inputs,
        })
      } else props.setModal({ ...modal, index: next, inputs })
    }
    return (
      <ModalBox height={props.height} title={prompt.message}>
        {prompt.type === 'select' ? (
          <SelectInput
            limit={listLimit}
            items={prompt.options.map((item) => ({ label: item.label, value: item.value }))}
            onSelect={(item) => advance(item.value)}
          />
        ) : (
          <TextInput
            value={props.oauthCode}
            onChange={props.setOAuthCode}
            onSubmit={(value) => { props.setOAuthCode(''); advance(value) }}
          />
        )}
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
      <ModalBox height={props.height} title={prompt.message}>
        {prompt.type === 'select' ? (
          <SelectInput
            limit={listLimit}
            items={prompt.options.map((item) => ({ label: item.label, value: item.value }))}
            onSelect={(item) => advance(item.value)}
          />
        ) : (
          <TextInput value={props.oauthCode} onChange={props.setOAuthCode} onSubmit={(value) => { props.setOAuthCode(''); advance(value) }} />
        )}
      </ModalBox>
    )
  }

  if (modal.type === 'oauth-wait') {
    return (
      <ModalBox height={props.height} title="Complete OAuth in your browser">
        <Text color="cyan" wrap="truncate-end">{modal.url}</Text>
        <Text wrap="truncate-end">{modal.instructions}</Text>
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
      <ModalBox height={props.height} title="Resume project session">
        <SelectInput
          limit={listLimit}
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
    if (isQuestionRequest(modal.request)) {
      return (
        <QuestionModalView
          key={modal.request.id}
          modal={modal}
          listLimit={listLimit}
          height={props.height}
          controller={controller}
          setModal={props.setModal}
          setMessages={props.setMessages}
        />
      )
    }
    return (
      <ModalBox height={props.height} title={`Permission: ${modal.request.action}`}>
        <Text wrap="truncate-end">{modal.request.resources.join(', ')}</Text>
        <SelectInput
          limit={Math.max(1, listLimit - 1)}
          items={[
            { label: 'Allow once', value: 'once' },
            { label: 'Allow for session', value: 'always' },
            { label: 'Deny', value: 'reject' },
          ]}
          onSelect={(item) => {
            const nextModal = nextPermissionModal(modal)
            void controller.replyPermission(modal.request, item.value as 'once' | 'always' | 'reject').finally(() => props.setModal(nextModal))
          }}
        />
      </ModalBox>
    )
  }

  if (modal.type === 'confirm-clear') {
    return (
      <ModalBox height={props.height} title={`Clear ${modal.scope} memory?`}>
        <SelectInput
          limit={listLimit}
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
    <ModalBox height={props.height} title="64-step ceiling reached">
      <Text wrap="truncate-end">The active tool completed. Start a fresh 64-step continuation?</Text>
      <SelectInput
        limit={Math.max(1, listLimit - 1)}
        items={[{ label: 'Stop', value: 'stop' }, { label: 'Continue', value: 'continue' }]}
        onSelect={(item) => {
          props.setModal({ type: 'none' })
          if (item.value === 'continue') void controller.submit('Continue from the current verified state.')
        }}
      />
    </ModalBox>
  )
}

function ModalBox({ title, height, children }: { title: string; height: number; children: React.ReactNode }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      height={height}
      overflow="hidden"
    >
      <Text bold color="cyan" wrap="truncate-end">{title}</Text>
      {children}
    </Box>
  )
}

export type QuestionOption = {
  label: string
  description?: string
  value: string
}

export type ExtractedQuestion = {
  header?: string | undefined
  questionText: string
  options: QuestionOption[]
  multiSelect?: boolean
}

export function isQuestionRequest(request: PermissionRequest): boolean {
  const action = request.action.toLowerCase()
  if (
    action.includes('question') ||
    action.includes('ask') ||
    action.includes('prompt') ||
    action.includes('input')
  ) {
    return true
  }
  const meta = request.metadata
  if (meta) {
    if (meta.questions || meta.question || meta.options || meta.prompt || meta.answers) return true
  }
  return false
}

export function extractQuestion(request: PermissionRequest): ExtractedQuestion {
  const meta = request.metadata ?? {}
  const questions = Array.isArray(meta.questions) ? (meta.questions as Record<string, unknown>[]) : []
  const firstQ = questions[0] ?? meta

  const header =
    typeof firstQ.header === 'string'
      ? firstQ.header
      : typeof meta.header === 'string'
        ? meta.header
        : undefined

  let questionText =
    typeof firstQ.question === 'string' && firstQ.question
      ? firstQ.question
      : typeof meta.question === 'string' && meta.question
        ? meta.question
        : typeof firstQ.prompt === 'string' && firstQ.prompt
          ? firstQ.prompt
          : typeof meta.prompt === 'string' && meta.prompt
            ? meta.prompt
            : typeof meta.message === 'string' && meta.message
              ? meta.message
              : request.resources.length > 0
                ? request.resources[0]!
                : request.action

  if (!questionText || questionText === 'unknown') {
    questionText = 'The model is asking a question:'
  }

  const rawOptions = Array.isArray(firstQ.options)
    ? firstQ.options
    : Array.isArray(meta.options)
      ? meta.options
      : request.resources.length > 1
        ? request.resources
        : []

  const options: QuestionOption[] = []

  for (const raw of rawOptions) {
    if (typeof raw === 'string') {
      options.push({ label: raw, value: raw })
    } else if (typeof raw === 'object' && raw !== null) {
      const rec = raw as Record<string, unknown>
      const label = String(rec.label ?? rec.value ?? rec.text ?? '')
      const description = typeof rec.description === 'string' ? rec.description : undefined
      const value = String(rec.value ?? rec.label ?? label)
      if (label) {
        options.push({ label, ...(description ? { description } : {}), value })
      }
    }
  }

  const multiSelect = Boolean(firstQ.multiSelect ?? meta.multiSelect)

  return {
    header,
    questionText,
    options,
    multiSelect,
  }
}

function QuestionModalView({
  modal,
  listLimit,
  height,
  controller,
  setModal,
}: {
  modal: Extract<Modal, { type: 'permission' }>
  listLimit: number
  height: number
  controller: CuppetController
  setModal(value: Modal): void
  setMessages: React.Dispatch<React.SetStateAction<MessageItem[]>>
}) {
  const [customText, setCustomText] = useState('')
  const extracted = useMemo(() => extractQuestion(modal.request), [modal.request])
  const [mode, setMode] = useState<'select' | 'custom'>(extracted.options.length > 0 ? 'select' : 'custom')

  const title = `Question: ${extracted.header ?? modal.request.action}`
  const nextModal = nextPermissionModal(modal)

  if (mode === 'select' && extracted.options.length > 0) {
    return (
      <ModalBox height={height} title={title}>
        <Text bold color="yellow" wrap="truncate-end">{extracted.questionText}</Text>
        <SelectInput
          limit={Math.max(1, listLimit - 1)}
          items={[
            ...extracted.options.map((opt) => ({
              label: `${opt.label}${opt.description ? ` · ${opt.description}` : ''}`,
              value: opt.value,
            })),
            { label: 'Type custom answer…', value: '__custom' },
            { label: 'Deny / Cancel', value: '__reject' },
          ]}
          onSelect={(item) => {
            if (item.value === '__custom') {
              setMode('custom')
              return
            }
            if (item.value === '__reject') {
              void controller.replyPermission(modal.request, 'reject').finally(() => setModal(nextModal))
              return
            }
            void controller
              .replyPermission(modal.request, 'once', item.value)
              .finally(() => setModal(nextModal))
          }}
        />
      </ModalBox>
    )
  }

  return (
    <ModalBox height={height} title={title}>
      <Text bold color="yellow" wrap="truncate-end">{extracted.questionText}</Text>
      <Text dimColor wrap="truncate-end">Type your answer below and press Enter (Esc to cancel):</Text>
      <TextInput
        value={customText}
        onChange={setCustomText}
        onSubmit={(value) => {
          const answer = value.trim()
          if (!answer) return
          setCustomText('')
          void controller
            .replyPermission(modal.request, 'once', answer)
            .finally(() => setModal(nextModal))
        }}
      />
    </ModalBox>
  )
}

const Message = React.memo(function Message({ item }: { item: MessageLine }) {
  if (item.kind === 'code-header') {
    return (
      <Box height={1} width="100%" paddingX={1} overflow="hidden">
        <Text backgroundColor="gray" color="white" bold wrap="truncate-end">{item.language ?? item.text}</Text>
      </Box>
    )
  }

  if (item.kind === 'code') {
    return (
      <Box height={1} width="100%" paddingX={1} overflow="hidden">
        <Text backgroundColor="gray" color="white" wrap="truncate-end">{item.text || ' '}</Text>
      </Box>
    )
  }

  if (item.kind === 'diagram-header') {
    return (
      <Text bold color="cyan" wrap="truncate-end">
        <Text color="magenta">◇ </Text>{item.text}
      </Text>
    )
  }

  if (item.kind === 'diagram-edge') {
    return (
      <Text wrap="truncate-end">
        <Text color="magenta">↳ </Text>{parseInlineMarkdown(item.text)}
      </Text>
    )
  }

  if (item.kind === 'table-header') {
    return <Text bold color="cyan" wrap="truncate-end">{item.text}</Text>
  }

  if (item.kind === 'table-divider') {
    return <Text color="gray" dimColor wrap="truncate-end">{item.text}</Text>
  }

  if (item.kind === 'table-row') {
    return <Text wrap="truncate-end">{item.text}</Text>
  }

  return renderMarkdownLine(item.text, item.sender)
})

function renderMarkdownLine(text: string, sender: MessageItem['sender']) {
  if (sender === 'tool' || text.startsWith('diff -- ')) {
    if (text.startsWith('diff -- ')) {
      const match = /^diff -- (.+?)(?:\s+·\s+\+(\d+)\s+-(\d+))?$/.exec(text)
      const file = match?.[1] ?? text.replace(/^diff -- /, '').split(' · ')[0] ?? text
      const adds = match?.[2]
      const dels = match?.[3]

      if (!file || file === 'file' || file === 'undefined' || file === 'null') {
        return null
      }

      return (
        <Text wrap="truncate-end">
          <Text color="cyan" bold>{file}</Text>
          {adds !== undefined && dels !== undefined ? (
            <>
              <Text color="gray"> · </Text>
              <Text color="green">+{adds}</Text>
              <Text color="red"> -{dels}</Text>
            </>
          ) : null}
        </Text>
      )
    }

    if (text.startsWith('+')) {
      return (
        <Text color="green" wrap="truncate-end">
          {text}
        </Text>
      )
    }

    if (text.startsWith('-')) {
      return (
        <Text color="red" wrap="truncate-end">
          {text}
        </Text>
      )
    }

    if (text.startsWith('@@') || text.startsWith('+++ ') || text.startsWith('--- ')) {
      return (
        <Text color="cyan" wrap="truncate-end">
          {text}
        </Text>
      )
    }

    if (text.startsWith('…') || text.includes('more line(s)')) {
      return (
        <Text color="gray" dimColor wrap="truncate-end">
          {text}
        </Text>
      )
    }
  }

  const headerMatch = /^(#{1,6})\s+(.*)$/.exec(text)
  if (headerMatch) {
    const level = headerMatch[1]?.length ?? 1
    const content = headerMatch[2] ?? ''
    return (
      <Text bold color={level === 1 ? 'yellow' : level === 2 ? 'cyan' : 'blue'} wrap="truncate-end">
        {content}
      </Text>
    )
  }

  if (text.startsWith('> ')) {
    return (
      <Text dimColor italic wrap="truncate-end">
        <Text color="gray">│ </Text>{parseInlineMarkdown(text.slice(2))}
      </Text>
    )
  }

  const listMatch = /^(\s*[-*]|\s*\d+\.)\s+(.*)$/.exec(text)
  if (listMatch) {
    const bullet = listMatch[1]?.includes('.') ? listMatch[1] : '•'
    const content = listMatch[2] ?? ''
    return (
      <Text wrap="truncate-end">
        <Text color="cyan" bold>{bullet} </Text>
        {parseInlineMarkdown(content)}
      </Text>
    )
  }

  const defaultColor = sender === 'user' ? 'green' : sender === 'system' ? 'yellow' : sender === 'tool' ? 'cyan' : undefined

  return (
    <Text {...(defaultColor ? { color: defaultColor } : {})} dimColor={sender === 'reasoning'} wrap="truncate-end">
      {parseInlineMarkdown(text)}
    </Text>
  )
}

function parseInlineMarkdown(text: string): React.ReactNode {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\([^)]+\))/g)
  if (tokens.length <= 1) return text

  return tokens.map((token, index) => {
    if (!token) return null
    if (token.startsWith('`') && token.endsWith('`')) {
      return (
        <Text key={index} color="magenta">
          {token.slice(1, -1)}
        </Text>
      )
    }
    if ((token.startsWith('**') && token.endsWith('**')) || (token.startsWith('__') && token.endsWith('__'))) {
      return (
        <Text key={index} bold>
          {token.slice(2, -2)}
        </Text>
      )
    }
    const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
    if (linkMatch) {
      return (
        <Text key={index} color="cyan" underline>
          {linkMatch[1]}
        </Text>
      )
    }
    return token
  })
}

async function openAction(
  action: CommandAction,
  controller: CuppetController,
  setModal: (modal: Modal) => void,
  setMessages: React.Dispatch<React.SetStateAction<MessageItem[]>>,
) {
  if (action.type === 'status') {
    try {
      setModal({ type: 'status', data: await controller.status() })
    } catch (error) {
      addMessage(setMessages, 'system', `Status error: ${(error as Error).message}`)
    }
  } else if (action.type === 'platform') setModal({ type: 'platform', required: false })
  else if (action.type === 'model') {
    const snapshot = controller.snapshot
    if (!snapshot.platform) setModal({ type: 'platform', required: true })
    else if (controller.modelsForPlatform(snapshot.platform, action.role).length === 0) {
      if (snapshot.platform === 'vertex' && controller.integrationsForPlatform('vertex').length === 0) {
        setModal({ type: 'vertex-setup', required: false })
      } else {
        setModal({ type: 'login-integration', platform: snapshot.platform, required: true })
      }
    } else setModal({ type: 'model', role: action.role, required: false })
  }
  else if (action.type === 'effort') {
    try {
      const options = controller.effortOptions(action.role)
      if (options.length === 0) {
        const model = action.role === 'primary' ? controller.snapshot.primary : controller.snapshot.secondary
        throw new Error(`${model ? `${model.providerID}/${model.modelID}` : `The ${action.role} model`} does not advertise configurable effort levels`)
      }
      setModal({ type: 'effort', role: action.role, options })
    } catch (error) {
      addMessage(setMessages, 'system', `Effort error: ${(error as Error).message}`)
    }
  }
  else if (action.type === 'login') {
    const provider = action.provider?.toLowerCase()
    if ((provider === 'vertex' || provider === 'google-vertex') && controller.integrationsForPlatform('vertex').length === 0) {
      setModal({ type: 'vertex-setup', required: false })
    } else {
      setModal({ type: 'login-integration', ...(action.provider ? { provider: action.provider } : {}) })
    }
  }
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
    props.setModal({ type: 'oauth-wait', integration, method, ...attempt })
  } catch (error) {
    addMessage(props.setMessages, 'system', `OAuth failed: ${(error as Error).message}`)
    props.setModal({ type: 'none' })
  }
}

let activeTurnSegment = 0
const activeToolInfos = new Map<string, { name: string; detail?: string; input?: unknown }>()

function unwrapToolInput(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object') return undefined
  let target = input as Record<string, unknown>
  if (target.input && typeof target.input === 'object') target = target.input as Record<string, unknown>
  else if (target.args && typeof target.args === 'object') target = target.args as Record<string, unknown>
  else if (target.parameters && typeof target.parameters === 'object') target = target.parameters as Record<string, unknown>
  else if (target.params && typeof target.params === 'object') target = target.params as Record<string, unknown>
  return target
}

export function formatToolLineStats(name: string, input: unknown): string | undefined {
  const rec = unwrapToolInput(input)
  if (!rec) return undefined

  const toolName = name.toLowerCase()

  if ((toolName.includes('edit') || toolName.includes('patch') || toolName.includes('replace')) && !toolName.includes('notebook')) {
    const oldStr =
      typeof rec.old_string === 'string'
        ? rec.old_string
        : typeof rec.oldString === 'string'
          ? rec.oldString
          : typeof rec.old_content === 'string'
            ? rec.old_content
            : typeof rec.oldContent === 'string'
              ? rec.oldContent
              : undefined
    const newStr =
      typeof rec.new_string === 'string'
        ? rec.new_string
        : typeof rec.newString === 'string'
          ? rec.newString
          : typeof rec.new_content === 'string'
            ? rec.new_content
            : typeof rec.newContent === 'string'
              ? rec.newContent
              : typeof rec.replacement === 'string'
                ? rec.replacement
                : undefined

    if (oldStr !== undefined || newStr !== undefined) {
      const deletions = oldStr ? oldStr.split('\n').length : 0
      const additions = newStr ? newStr.split('\n').length : 0
      return `+${additions} -${deletions}`
    }
  }

  if (toolName.includes('write')) {
    const content =
      typeof rec.content === 'string'
        ? rec.content
        : typeof rec.new_string === 'string'
          ? rec.new_string
          : typeof rec.newContent === 'string'
            ? rec.newContent
            : undefined
    if (content !== undefined) {
      const additions = content ? content.split('\n').length : 0
      return `+${additions}`
    }
  }

  if (toolName.includes('notebook') || toolName.includes('cell')) {
    const newSource = typeof rec.new_source === 'string' ? rec.new_source : typeof rec.newSource === 'string' ? rec.newSource : undefined
    if (newSource !== undefined) {
      const additions = newSource ? newSource.split('\n').length : 0
      return `+${additions}`
    }
  }

  return undefined
}

export function formatToolDiff(name: string, input: unknown): string | undefined {
  const rec = unwrapToolInput(input)
  if (!rec) return undefined

  const toolName = name.toLowerCase()

  let filePath =
    typeof rec.file_path === 'string'
      ? rec.file_path
      : typeof rec.path === 'string'
        ? rec.path
        : typeof rec.file === 'string'
          ? rec.file
          : typeof rec.filename === 'string'
            ? rec.filename
            : typeof rec.notebook_path === 'string'
              ? rec.notebook_path
              : typeof rec.target === 'string'
                ? rec.target
                : typeof rec.filepath === 'string'
                  ? rec.filepath
                  : typeof rec.file_name === 'string'
                    ? rec.file_name
                    : typeof rec.resource === 'string'
                      ? rec.resource
                      : typeof rec.uri === 'string'
                        ? rec.uri
                        : ''

  if (filePath === 'file' || filePath === 'undefined' || filePath === 'null') {
    filePath = ''
  }

  try {
    const cwd = process.cwd()
    if (cwd && filePath.startsWith(cwd)) {
      filePath = filePath.slice(cwd.length).replace(/^[/\\]+/, '')
    }
  } catch {
    // Ignore cwd errors
  }

  if ((toolName.includes('edit') || toolName.includes('patch') || toolName.includes('replace')) && !toolName.includes('notebook')) {
    const oldStr =
      typeof rec.old_string === 'string'
        ? rec.old_string
        : typeof rec.oldString === 'string'
          ? rec.oldString
          : typeof rec.old_content === 'string'
            ? rec.old_content
            : typeof rec.oldContent === 'string'
              ? rec.oldContent
              : undefined
    const newStr =
      typeof rec.new_string === 'string'
        ? rec.new_string
        : typeof rec.newString === 'string'
          ? rec.newString
          : typeof rec.new_content === 'string'
            ? rec.new_content
            : typeof rec.newContent === 'string'
              ? rec.newContent
              : typeof rec.replacement === 'string'
                ? rec.replacement
                : undefined

    if (oldStr !== undefined || newStr !== undefined) {
      return formatDiff([{ file: filePath, before: oldStr ?? '', after: newStr ?? '' }])
    }
  }

  if (toolName.includes('write')) {
    const content =
      typeof rec.content === 'string'
        ? rec.content
        : typeof rec.new_string === 'string'
          ? rec.new_string
          : typeof rec.newContent === 'string'
            ? rec.newContent
            : undefined
    if (content !== undefined) {
      return formatDiff([{ file: filePath, before: '', after: content }])
    }
  }

  if (toolName.includes('notebook') || toolName.includes('cell')) {
    const newSource = typeof rec.new_source === 'string' ? rec.new_source : typeof rec.newSource === 'string' ? rec.newSource : undefined
    const oldSource = typeof rec.old_source === 'string' ? rec.old_source : typeof rec.oldSource === 'string' ? rec.oldSource : ''
    if (newSource !== undefined) {
      return formatDiff([{ file: filePath, before: oldSource, after: newSource }])
    }
  }

  return undefined
}

export function formatToolDetail(name: string, input: unknown): string | undefined {
  if (!input) return undefined

  let target = input
  if (typeof target === 'object' && target !== null) {
    const rec = target as Record<string, unknown>
    if (rec.input && typeof rec.input === 'object') target = rec.input
    else if (rec.args && typeof rec.args === 'object') target = rec.args
    else if (rec.parameters && typeof rec.parameters === 'object') target = rec.parameters
    else if (rec.params && typeof rec.params === 'object') target = rec.params
  }

  let rawStr: string | undefined

  if (typeof target === 'string') {
    rawStr = target.trim()
  } else if (typeof target === 'object' && target !== null) {
    const rec = target as Record<string, unknown>
    const candidate =
      rec.command ??
      rec.file_path ??
      rec.path ??
      rec.file ??
      rec.filename ??
      rec.notebook_path ??
      rec.pattern ??
      rec.query ??
      rec.description ??
      rec.subject ??
      rec.prompt ??
      rec.url ??
      rec.skill ??
      rec.subagent_type ??
      rec.name

    if (typeof candidate === 'string' && candidate.trim()) {
      rawStr = candidate.trim()
    } else {
      for (const val of Object.values(rec)) {
        if (typeof val === 'string' && val.trim() && val.length < 300) {
          rawStr = val.trim()
          break
        }
      }
    }
  }

  if (!rawStr) return undefined

  const firstLine = rawStr.split(/\r?\n/)[0]?.trim() ?? ''
  if (!firstLine) return undefined

  let cleaned = firstLine
  try {
    const cwd = process.cwd()
    if (cwd && cleaned.startsWith(cwd)) {
      cleaned = cleaned.slice(cwd.length).replace(/^[/\\]+/, '')
    }
  } catch {
    // Ignore cwd check errors
  }

  if (cleaned.length > 60) {
    cleaned = `${cleaned.slice(0, 57)}…`
  }

  return cleaned
}

function handleAgentEvent(
  event: AgentEvent,
  setMessages: React.Dispatch<React.SetStateAction<MessageItem[]>>,
  setModal: React.Dispatch<React.SetStateAction<Modal>>,
  setNotice: (notice: string | undefined) => void,
) {
  if (event.type !== 'text-delta' && event.type !== 'reasoning-delta') {
    flushStreamBuffers(setMessages)
  }
  if (event.type === 'text-delta') {
    removeMessage(setMessages, `thinking:${event.sessionID}`)
    appendStream(setMessages, 'assistant', `assistant:${event.sessionID}:${activeTurnSegment}`, event.text)
  } else if (event.type === 'reasoning-delta') {
    removeMessage(setMessages, `thinking:${event.sessionID}`)
  } else if (event.type === 'tool-start') {
    const existing = activeToolInfos.get(event.callID)
    const detail = formatToolDetail(event.name, event.input) ?? existing?.detail
    const name = event.name === 'tool' && existing ? existing.name : event.name
    const input = event.input ?? existing?.input
    activeToolInfos.set(event.callID, { name, ...(detail ? { detail } : {}), ...(input !== undefined ? { input } : {}) })
    const base = detail ? `${name} (${detail})` : name
    if (existing) updateMessage(setMessages, `tool:${event.callID}`, base)
    else addMessage(setMessages, 'tool', base, `tool:${event.callID}`)
  } else if (event.type === 'tool-progress') {
    const info = activeToolInfos.get(event.callID)
    const base = info ? (info.detail ? `${info.name} (${info.detail})` : info.name) : 'tool'
    updateMessage(setMessages, `tool:${event.callID}`, `${base} · ${event.message}`)
  } else if (event.type === 'tool-end') {
    const info = activeToolInfos.get(event.callID)
    const input = event.input ?? info?.input
    let detail = info?.detail
    if (!detail && event.outputPaths?.length) {
      detail = formatToolDetail(info?.name ?? 'tool', event.outputPaths[0])
    }
    const lineStats = formatToolLineStats(info?.name ?? event.name ?? 'tool', input)
    const base = info ? (detail ? `${info.name} (${detail})` : info.name) : 'tool'
    const statsPart = lineStats ? ` · ${lineStats}` : ''
    updateMessage(setMessages, `tool:${event.callID}`, `${base}${statsPart} · ${event.success ? 'completed' : 'failed'}`)
    if (event.success) {
      const toolDiff = formatToolDiff(info?.name ?? event.name ?? 'tool', input)
      if (toolDiff) {
        addMessage(setMessages, 'tool', toolDiff)
      }
    }
    activeToolInfos.delete(event.callID)
    activeTurnSegment += 1
  } else if (event.type === 'idle') {
    removeMessage(setMessages, `thinking:${event.sessionID}`)
  } else if (event.type === 'diff') addMessage(setMessages, 'tool', formatDiff(event.diff))
  else if (event.type === 'permission') {
    setModal((prev) => {
      if (prev.type === 'permission') {
        const queue = prev.queue ?? []
        const pending = [prev.request, ...queue]
        if (pending.some((request) => request.id === event.request.id)) return prev
        return { type: 'permission', request: prev.request, queue: [...queue, event.request] }
      }
      return { type: 'permission', request: event.request }
    })
  }
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
    } else if (event.method === 'health.degraded') {
      const detail = event.params as { message?: string }
      setNotice(`TST unavailable — OpenCode-only mode${detail.message ? `: ${detail.message}` : ''}`)
    }
  }
}

function removeMessage(
  setMessages: React.Dispatch<React.SetStateAction<MessageItem[]>>,
  id: string,
) {
  setMessages((current) => current.filter((item) => item.id !== id))
}

function updateMessage(
  setMessages: React.Dispatch<React.SetStateAction<MessageItem[]>>,
  id: string,
  text: string,
) {
  setMessages((current) => {
    const index = current.findIndex((item) => item.id === id)
    if (index < 0) return [...current, { id, sender: 'tool', text }]
    return current.map((item, itemIndex) => itemIndex === index ? { ...item, text } : item)
  })
}

function addMessage(
  setMessages: React.Dispatch<React.SetStateAction<MessageItem[]>>,
  sender: MessageItem['sender'],
  text: string,
  id = `${Date.now()}:${Math.random()}`,
) {
  setMessages((current) => [...current, { id, sender, text }])
}

const streamBuffers = new Map<string, { sender: MessageItem['sender']; text: string }>()
let streamFlushTimer: NodeJS.Timeout | undefined

function flushStreamBuffers(setMessages: React.Dispatch<React.SetStateAction<MessageItem[]>>) {
  if (streamFlushTimer) {
    clearTimeout(streamFlushTimer)
    streamFlushTimer = undefined
  }
  if (streamBuffers.size === 0) return
  const entries = Array.from(streamBuffers.entries())
  streamBuffers.clear()

  setMessages((current) => {
    let updated = current
    for (const [id, { sender, text }] of entries) {
      const index = updated.findIndex((item) => item.id === id)
      if (index < 0) {
        updated = [...updated, { id, sender, text }]
      } else {
        const item = updated[index]!
        updated = updated.map((it, idx) => (idx === index ? { ...it, text: `${item.text}${text}` } : it))
      }
    }
    return updated
  })
}

function appendStream(
  setMessages: React.Dispatch<React.SetStateAction<MessageItem[]>>,
  sender: MessageItem['sender'],
  id: string,
  delta: string,
) {
  const existing = streamBuffers.get(id)
  if (existing) {
    existing.text += delta
  } else {
    streamBuffers.set(id, { sender, text: delta })
  }
  if (!streamFlushTimer) {
    streamFlushTimer = setTimeout(() => flushStreamBuffers(setMessages), 50)
  }
}

function modelLabel(model?: ModelRef): string {
  return model ? `${model.providerID}/${model.modelID}${model.variant ? `@${model.variant}` : ''}` : 'not selected'
}

export type ModelPickerChoice = {
  model: ModelRef
  name: string
  efforts: string[]
}

export function modelPickerChoices(models: ModelInfo[]): ModelPickerChoice[] {
  const groups = new Map<string, ModelInfo[]>()
  for (const model of models) {
    const key = modelPickerValue(model)
    const group = groups.get(key)
    if (group) group.push(model)
    else groups.set(key, [model])
  }
  return [...groups.values()].map((group) => {
    const baseModel = group.find((model) => model.variant === undefined) ?? group[0]!
    return {
      model: { providerID: baseModel.providerID, modelID: baseModel.modelID },
      name: pickerModelName(baseModel),
      efforts: [...new Set(group.flatMap((model) => model.variant ? [model.variant] : []))],
    }
  })
}

function modelPickerValue(model: Pick<ModelRef, 'providerID' | 'modelID'>): string {
  return `${model.providerID}\u0000${model.modelID}`
}

function pickerModelName(model: ModelInfo): string {
  const suffix = model.variant ? ` [${model.variant}]` : ''
  return suffix && model.name.endsWith(suffix)
    ? model.name.slice(0, -suffix.length)
    : model.name
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`
}

function sameModelFamily(left: ModelRef, right: ModelRef): boolean {
  return left.providerID === right.providerID && left.modelID === right.modelID
}

export function formatDiff(diffData: unknown): string {
  if (typeof diffData === 'string') {
    return formatDiffString(diffData)
  }
  if (!Array.isArray(diffData)) {
    return String(diffData)
  }
  const lines: string[] = []
  for (const item of diffData) {
    if (!item || typeof item !== 'object') continue
    const entry = item as {
      path?: string
      file?: string
      before?: string
      after?: string
      additions?: number
      deletions?: number
      chunks?: unknown[]
      hunks?: unknown[]
    }
    let file = String(entry.path ?? entry.file ?? '')
    if (file === 'file' || file === 'undefined' || file === 'null') {
      file = ''
    }

    const preview = typeof entry.before === 'string' && typeof entry.after === 'string'
      ? changedLinePreview(entry.before, entry.after)
      : []

    const additions = Number.isFinite(entry.additions) ? Math.max(0, Number(entry.additions)) : countPrefixed(preview, '+')
    const deletions = Number.isFinite(entry.deletions) ? Math.max(0, Number(entry.deletions)) : countPrefixed(preview, '-')

    if (file) {
      if (additions > 0 || deletions > 0) {
        lines.push(`diff -- ${file} · +${additions} -${deletions}`)
      } else {
        lines.push(`diff -- ${file}`)
      }
    }

    const chunks = entry.chunks ?? entry.hunks
    if (Array.isArray(chunks)) {
      for (const chunk of chunks) {
        const header = String((chunk as { header?: string }).header ?? '@@')
        lines.push(header)
        const chunkLines = (chunk as { lines?: string[] }).lines
        if (Array.isArray(chunkLines)) {
          for (const line of chunkLines) {
            lines.push(line)
          }
        }
      }
    } else {
      lines.push(...preview)
    }
  }
  return lines.join('\n')
}

export function diffLineColor(
  text: string,
  sender: MessageItem['sender'],
): 'cyan' | 'green' | 'red' | undefined {
  if (sender !== 'tool') return undefined
  if (text.startsWith('diff ') || text.startsWith('@@') || text.startsWith('+++ ') || text.startsWith('--- ')) return 'cyan'
  if (text.startsWith('+')) return 'green'
  if (text.startsWith('-')) return 'red'
  return undefined
}

function changedLinePreview(before: string, after: string): string[] {
  const oldLines = before ? before.split('\n') : []
  const newLines = after ? after.split('\n') : []
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1

  const removed = oldLines.slice(prefix, oldLines.length - suffix)
  const added = newLines.slice(prefix, newLines.length - suffix)
  return [
    ...previewLines(removed, '-'),
    ...previewLines(added, '+'),
  ]
}

function previewLines(lines: string[], prefix: '+' | '-'): string[] {
  const limit = 3
  const preview = lines.slice(0, limit).map((line) => `${prefix}${line}`)
  if (lines.length > limit) preview.push(`… ${lines.length - limit} more line(s)`)
  return preview
}

function countPrefixed(lines: string[], prefix: '+' | '-'): number {
  return lines.filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}${prefix} `)).length
}

function formatDiffString(diffText: string): string {
  const lines = diffText.split('\n')
  const result: string[] = []
  let contextCount = 0
  for (const line of lines) {
    if (line.startsWith('+') || line.startsWith('-') || line.startsWith('@@') || line.startsWith('diff ')) {
      result.push(line)
      contextCount = 0
    } else {
      contextCount += 1
      if (contextCount <= 3) {
        result.push(` ${line.trimStart()}`)
      }
    }
  }
  return result.join('\n')
}

function nextOnboardingModal(controller: CuppetController, snapshot: ControllerSnapshot): Modal {
  if (!snapshot.platform) return { type: 'platform', required: true }
  if (!snapshot.primary) {
    if (controller.modelsForPlatform(snapshot.platform, 'primary').length > 0) {
      return { type: 'model', role: 'primary', required: true }
    }
    if (controller.integrationsForPlatform(snapshot.platform).length > 0) {
      return {
        type: 'login-integration',
        platform: snapshot.platform,
        required: true,
      }
    }
    if (snapshot.platform === 'vertex') return { type: 'vertex-setup', required: true }
    return { type: 'platform', required: true }
  }
  if (!snapshot.secondary) {
    if (controller.modelsForPlatform(snapshot.platform, 'secondary').length > 0) {
      return { type: 'model', role: 'secondary', required: true }
    }
    return snapshot.platform === 'vertex'
      ? { type: 'vertex-setup', required: true }
      : { type: 'platform', required: true }
  }
  return { type: 'none' }
}

function nextModelSelectionModal(role: 'primary' | 'secondary', snapshot: ControllerSnapshot): Modal {
  return role === 'primary' && !snapshot.secondary
    ? { type: 'model', role: 'secondary', required: true }
    : { type: 'none' }
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
