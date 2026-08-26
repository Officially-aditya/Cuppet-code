import { CuppetControlClient } from './control.js'

export type ModelRow = {
  providerID: string
  modelID: string
  name: string
  efforts: string[]
}

/** Keep one visible model row and put all variants in the follow-up dialog. */
export function uniqueModelRows(
  models: Array<{ providerID: string; modelID: string; name: string; variant?: string }>,
): ModelRow[] {
  const rows = new Map<string, ModelRow>()
  for (const model of models) {
    const key = `${model.providerID}\u0000${model.modelID}`
    const row = rows.get(key) ?? {
      providerID: model.providerID,
      modelID: model.modelID,
      name: model.name.replace(/\s+\[[^\]]+\]$/, ''),
      efforts: [],
    }
    if (model.variant && !row.efforts.includes(model.variant)) row.efforts.push(model.variant)
    rows.set(key, row)
  }
  return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name))
}

export function modelSelectionSequence(row: ModelRow): Array<'model' | 'effort'> {
  return row.efforts.length > 0 ? ['model', 'effort'] : ['model']
}

type TuiToast = {
  variant?: 'info' | 'success' | 'warning' | 'error'
  title?: string
  message: string
  duration?: number
}

type TuiCommand = {
  name: string
  title: string
  desc?: string
  category?: string
  namespace?: string
  slashName?: string
  slashAliases?: string[]
  run: () => void | Promise<void>
}

type TuiApi = {
  keymap: {
    registerLayer(layer: { priority?: number; commands: TuiCommand[] }): () => void
    dispatchCommand(name: string): void
  }
  ui: {
    toast(toast: TuiToast): void
    dialog?: {
      replace(render: () => unknown, onClose?: () => void): void
      clear(): void
      setSize?(size: 'medium' | 'large' | 'xlarge'): void
    }
    DialogAlert?: (props: { title: string; message: string; onConfirm?: () => void }) => unknown
    DialogPrompt?: (props: {
      title: string
      placeholder?: string
      value?: string
      onConfirm?: (value: string) => void
      onCancel?: () => void
    }) => unknown
    DialogSelect?: <Value>(props: {
      title: string
      placeholder?: string
      options: Array<{
        title: string
        value: Value
        description?: string
        footer?: string
      }>
      current?: Value
      onSelect?: (option: { title: string; value: Value }) => void
    }) => unknown
  }
  route?: {
    current?: { name?: string; params?: Record<string, unknown> }
  }
  /** Native OpenCode agent state; supplied by the derivative TUI patch. */
  agent?: {
    current(): string | { id?: string; name?: string } | Promise<string | { id?: string; name?: string }>
    set(agent: string): void | Promise<void>
  }
  client?: {
    session?: {
      abort(input: { sessionID: string }): Promise<unknown>
    }
  }
}

type TuiPluginModule = {
  id: 'cuppet-tui'
  tui(api: TuiApi): Promise<void>
}

const CuppetTuiPlugin: TuiPluginModule = {
  id: 'cuppet-tui',
  async tui(api) {
    if (!process.env.CUPPET_CONTROL_SOCKET || !process.env.CUPPET_CONTROL_TOKEN) return
    const client = new CuppetControlClient()

    const action = async (
      title: string,
      method: string,
      params: Record<string, unknown>,
      message: string | ((result: unknown) => string),
    ) => {
      try {
        const result = await client.call(method, params)
        api.ui.toast({
          title,
          variant: 'success',
          message: typeof message === 'function' ? message(result) : message,
        })
      } catch (error) {
        api.ui.toast({
          title,
          variant: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const dispatch = (name: string) => () => api.keymap.dispatchCommand(name)
    const sessionID = () => {
      const value = api.route?.current?.params?.sessionID
      return typeof value === 'string' ? value : undefined
    }

    const prompt = (title: string, placeholder: string, onConfirm: (value: string) => void) => {
      if (!api.ui.dialog || !api.ui.DialogPrompt) {
        api.ui.toast({ title, variant: 'warning', message: 'This Cuppet dialog is unavailable in the current TUI.' })
        return
      }
      api.ui.dialog.replace(() => api.ui.DialogPrompt!({
        title,
        placeholder,
        onConfirm: (value) => {
          api.ui.dialog?.clear()
          onConfirm(value)
        },
        onCancel: () => api.ui.dialog?.clear(),
      }))
    }

    const choosePlatform = async () => {
      if (!api.ui.dialog || !api.ui.DialogSelect) {
        api.ui.toast({ title: 'Cuppet platform', variant: 'warning', message: 'The platform dialog is unavailable.' })
        return
      }
      try {
        const state = await client.call<{
          selected?: string
          options: Array<{ value: string; label: string; description: string; models: number; connected: boolean }>
        }>('platform.list')
        api.ui.dialog.replace(() => api.ui.DialogSelect!({
          title: 'Choose Cuppet platform',
          placeholder: 'Search platforms',
          current: state.selected,
          options: state.options.map((option) => ({
            title: option.label,
            value: option.value,
            description: option.description,
            footer: `${option.models} models${option.connected ? ' · connected' : ''}`,
          })),
          onSelect: (option) => {
            api.ui.dialog?.clear()
            void client.call<{ selected?: string }>('platform.select', { platform: option.value })
              .then(() => {
                api.ui.toast({
                  title: 'Cuppet platform',
                  variant: 'success',
                  message: `${option.title} selected. Choose the foreground model.`,
                })
                api.keymap.dispatchCommand('model.list')
              })
              .catch((error) => api.ui.toast({
                title: 'Cuppet platform',
                variant: 'error',
                message: error instanceof Error ? error.message : String(error),
              }))
          },
        }))
      } catch (error) {
        api.ui.toast({
          title: 'Cuppet platform',
          variant: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const showStatus = async () => {
      if (!api.ui.dialog || !api.ui.DialogAlert) {
        api.ui.toast({ title: 'Cuppet status', variant: 'warning', message: 'The status dialog is unavailable.' })
        return
      }
      try {
        const status = await client.call<Record<string, unknown>>('status')
        api.ui.dialog.setSize?.('large')
        api.ui.dialog.replace(() => api.ui.DialogAlert!({
          title: 'Cuppet status',
          message: formatStatus(status),
          onConfirm: () => api.ui.dialog?.clear(),
        }))
      } catch (error) {
        api.ui.toast({
          title: 'Cuppet status',
          variant: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const showRemote = async () => {
      try {
        const status = await client.call<Record<string, unknown>>('remote.start')
        if (!api.ui.dialog || !api.ui.DialogAlert) {
          const invite = record(status.invite)
          api.ui.toast({
            title: 'Cuppet remote control',
            variant: 'success',
            message: stringValue(invite.code) ? `Pairing code: ${invite.code}` : 'Remote control is running.',
          })
          return
        }
        api.ui.dialog.setSize?.('large')
        api.ui.dialog.replace(() => api.ui.DialogAlert!({
          title: 'Cuppet remote control',
          message: formatRemoteControl(status),
          onConfirm: () => api.ui.dialog?.clear(),
        }))
      } catch (error) {
        api.ui.toast({
          title: 'Cuppet remote control',
          variant: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const stopRemote = async () => {
      try {
        await client.call('remote.stop')
        api.ui.toast({ title: 'Cuppet remote control', variant: 'success', message: 'Remote control stopped.' })
      } catch (error) {
        api.ui.toast({
          title: 'Cuppet remote control',
          variant: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const toggleAutoMode = async () => {
      try {
        const status = await client.call<{ enabled?: boolean }>('auto.status')
        const enabled = !status.enabled
        await client.call('auto.set', {
          enabled,
          ...(sessionID() ? { sessionID: sessionID() } : {}),
        })
        api.ui.toast({
          title: 'Cuppet auto mode',
          variant: 'success',
          message: enabled
            ? 'Auto mode ON: workspace reads and edits are approved. Protected files, external paths, and non-safe Bash commands still ask.'
            : 'Auto mode OFF: permission requests will ask again.',
        })
      } catch (error) {
        api.ui.toast({
          title: 'Cuppet auto mode',
          variant: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const showReport = async (
      title: string,
      method: string,
      formatter: (result: unknown) => string,
    ) => {
      if (!api.ui.dialog || !api.ui.DialogAlert) {
        api.ui.toast({ title, variant: 'warning', message: 'This report dialog is unavailable.' })
        return
      }
      try {
        const result = await client.call(method)
        api.ui.dialog.setSize?.('large')
        api.ui.dialog.replace(() => api.ui.DialogAlert!({
          title,
          message: formatter(result),
          onConfirm: () => api.ui.dialog?.clear(),
        }))
      } catch (error) {
        api.ui.toast({ title, variant: 'error', message: error instanceof Error ? error.message : String(error) })
      }
    }

    // Keep this layer additive. A high-priority plugin layer makes lower host
    // layers unreachable in OpenTUI's palette/slash resolution and hides the
    // native OpenCode commands.
    api.keymap.registerLayer({
      commands: [
        {
          // Reuse the host command ID so Cuppet replaces OpenCode's default
          // status action instead of adding a second prefixed command.
          name: 'opencode.status',
          title: 'Cuppet status',
          desc: 'Show Cuppet runtime, foreground, background, and memory status',
          category: 'Cuppet',
          namespace: 'palette',
          slashName: 'status',
          run: showStatus,
        },
        {
          name: 'cuppet.doctor',
          title: 'Cuppet doctor',
          desc: 'Diagnose Cuppet runtime, provider, storage, and graph health',
          category: 'Cuppet',
          namespace: 'palette',
          slashName: 'doctor',
          run: () => showReport('Cuppet doctor', 'doctor', formatDoctor),
        },
        {
          name: 'cuppet.remote',
          title: 'Start Cuppet remote control',
          desc: 'Start phone/browser pairing for the current Cuppet host',
          category: 'Cuppet',
          namespace: 'palette',
          slashName: 'remote',
          slashAliases: ['remote-control'],
          run: showRemote,
        },
        {
          name: 'cuppet.remote.stop',
          title: 'Stop Cuppet remote control',
          desc: 'Disconnect the current phone/browser bridge',
          category: 'Cuppet',
          namespace: 'palette',
          slashName: 'remote-stop',
          run: stopRemote,
        },
        {
          name: 'cuppet.memory',
          title: 'Cuppet memory status',
          desc: 'Show Cuppet memory and graph status',
          category: 'Cuppet',
          namespace: 'palette',
          slashName: 'memory',
          run: () => showReport('Cuppet memory', 'status', formatMemory),
        },
        {
          name: 'cuppet.auto.toggle',
          title: 'Toggle Cuppet auto mode',
          desc: 'Auto-approve safe in-workspace reads and edits for this session',
          category: 'Cuppet',
          namespace: 'palette',
          slashName: 'auto',
          run: toggleAutoMode,
        },
        {
          name: 'cuppet.memory.remember',
          title: 'Remember a Cuppet preference',
          desc: 'Save a project or global key=value preference in memory',
          category: 'Cuppet',
          namespace: 'palette',
          run: () => prompt('Remember preference', 'project key=value', (value) => {
            const match = value.trim().match(/^(?:(project|global)\s+)?([^=\s]+)\s*=\s*(.+)$/i)
            if (!match) {
              api.ui.toast({ title: 'Cuppet memory', variant: 'warning', message: 'Use: project key=value or global key=value' })
              return
            }
            void action('Cuppet memory', 'memory.remember', {
              scope: (match[1] ?? 'project').toLowerCase(),
              key: match[2],
              value: match[3],
            }, 'Preference remembered.')
          }),
        },
        {
          name: 'cuppet.memory.forget',
          title: 'Forget a Cuppet preference',
          desc: 'Remove matching Cuppet memory by key',
          category: 'Cuppet',
          namespace: 'palette',
          run: () => prompt('Forget preference', 'key', (value) => {
            if (!value.trim()) return
            void action('Cuppet memory', 'memory.forget', { key: value.trim() }, removedMessage)
          }),
        },
        {
          name: 'cuppet.memory.clear',
          title: 'Clear Cuppet memory',
          desc: 'Clear session, project, or global Cuppet memory',
          category: 'Cuppet',
          namespace: 'palette',
          run: () => prompt('Clear memory', 'session, project, or global', (value) => {
            const scope = value.trim().toLowerCase()
            if (scope !== 'session' && scope !== 'project' && scope !== 'global') {
              api.ui.toast({ title: 'Cuppet memory', variant: 'warning', message: 'Scope must be session, project, or global.' })
              return
            }
            void action('Cuppet memory', 'memory.clear', { scope }, removedMessage)
          }),
        },
        {
          name: 'cuppet.background.toggle',
          title: 'Toggle Cuppet background enrichment',
          desc: 'Pause or resume background memory enrichment',
          category: 'Cuppet',
          namespace: 'palette',
          slashName: 'background',
          run: async () => {
            const status = await client.call<{ paused?: boolean }>('background.status')
            await client.call('background.set', { paused: !status.paused })
            api.ui.toast({
              title: 'Cuppet background',
              variant: 'success',
              message: status.paused ? 'Background enrichment resumed.' : 'Background enrichment paused.',
            })
          },
        },
        {
          name: 'cuppet.background.pause',
          title: 'Pause Cuppet background enrichment',
          desc: 'Pause background memory enrichment',
          category: 'Cuppet',
          namespace: 'palette',
          run: () => action('Cuppet background', 'background.set', { paused: true }, 'Background enrichment paused.'),
        },
        {
          name: 'cuppet.background.resume',
          title: 'Resume Cuppet background enrichment',
          desc: 'Resume background memory enrichment',
          category: 'Cuppet',
          namespace: 'palette',
          run: () => action('Cuppet background', 'background.set', { paused: false }, 'Background enrichment resumed.'),
        },
        {
          name: 'cuppet.orchestrator.toggle',
          title: 'Toggle Cuppet orchestrator mode',
          desc: 'Master/worker delegation: primary curates context and reviews, worker codes',
          category: 'Cuppet',
          namespace: 'palette',
          slashName: 'orchestrator',
          run: async () => {
            try {
              const status = await client.call<{ enabled?: boolean }>('orchestrator.status')
              const next = !status.enabled
              await client.call('orchestrator.set', { enabled: next })
              api.ui.toast({
                title: 'Cuppet orchestrator',
                variant: 'success',
                message: next
                  ? 'Orchestrator mode ON for new turns: you are the master; delegate coding to the worker (task tool), and curate context yourself with cuppet_* tools.'
                  : 'Orchestrator mode OFF: automatic TST context injection restored.',
              })
            } catch (error) {
              api.ui.toast({
                title: 'Cuppet orchestrator',
                variant: 'error',
                message: error instanceof Error ? error.message : String(error),
              })
            }
          },
        },
        {
          name: 'cuppet.platform',
          title: 'Choose Cuppet platform',
          desc: 'Choose Anthropic, OpenAI, Google, OpenCode, or Vertex AI',
          category: 'Cuppet',
          namespace: 'palette',
          slashName: 'platform',
          slashAliases: ['login'],
          run: choosePlatform,
        },
        {
          name: 'cuppet.model',
          title: 'Select Cuppet model',
          desc: 'Open the native model selection dialog',
          category: 'Cuppet',
          namespace: 'palette',
          slashName: 'model',
          run: dispatch('model.list'),
        },
        {
          name: 'cuppet.effort',
          title: 'Select model effort',
          desc: 'Open the native model effort/variant dialog',
          category: 'Cuppet',
          namespace: 'palette',
          slashName: 'effort',
          run: dispatch('variant.list'),
        },
        {
          name: 'cuppet.steer',
          title: 'Steer at the next safe boundary',
          desc: 'Queue an instruction for the active foreground session',
          category: 'Cuppet',
          namespace: 'palette',
          slashName: 'steer',
          run: () => prompt('Steer session', 'instruction', (value) => {
            if (!value.trim()) return
            void action('Cuppet steer', 'session.steer', { instruction: value.trim(), interrupt: false }, 'Steering instruction queued.')
          }),
        },
        {
          name: 'cuppet.steer.interrupt',
          title: 'Interrupt and steer immediately',
          desc: 'Interrupt the active foreground session and submit an instruction',
          category: 'Cuppet',
          namespace: 'palette',
          run: () => prompt('Interrupt and steer', 'instruction', (value) => {
            if (!value.trim()) return
            void action('Cuppet steer', 'session.steer', { instruction: value.trim(), interrupt: true }, 'Session interrupted; steering instruction submitted.')
          }),
        },
        {
          name: 'cuppet.abort',
          title: 'Abort active Cuppet session',
          desc: 'Abort the active foreground turn',
          category: 'Cuppet',
          namespace: 'palette',
          slashName: 'abort',
          run: async () => {
            const active = sessionID()
            if (!active || !api.client?.session?.abort) {
              api.ui.toast({ title: 'Cuppet abort', variant: 'warning', message: 'No active session.' })
              return
            }
            await api.client.session.abort({ sessionID: active })
            api.ui.toast({ title: 'Cuppet abort', variant: 'success', message: 'Active session aborted.' })
          },
        },
        {
          name: 'cuppet.plan',
          title: 'Switch native plan mode',
          desc: 'Switch directly between the native plan and build agents',
          category: 'Cuppet',
          namespace: 'palette',
          slashName: 'plan',
          run: async () => {
            if (!api.agent?.current || !api.agent.set) {
              api.ui.toast({
                title: 'Cuppet plan mode',
                variant: 'warning',
                message: 'Native agent controls are unavailable in this TUI.',
              })
              return
            }
            try {
              const value = await api.agent.current()
              const current = typeof value === 'string' ? value : value.id ?? value.name ?? ''
              const target = nextPlanAgent(current)
              await api.agent.set(target)
              await client.call('plan.set', {
                agent: target,
                ...(sessionID() ? { sessionID: sessionID() } : {}),
              })
              api.ui.toast({
                title: 'Cuppet plan mode',
                variant: 'success',
                message: target === 'plan' ? 'Plan mode enabled.' : 'Plan mode disabled.',
              })
            } catch (error) {
              api.ui.toast({
                title: 'Cuppet plan mode',
                variant: 'error',
                message: error instanceof Error ? error.message : String(error),
              })
            }
          },
        },
        {
          name: 'cuppet.plan.agent',
          title: 'Choose Cuppet plan agent',
          desc: 'Open the native agent picker for plan mode',
          category: 'Cuppet',
          namespace: 'palette',
          run: dispatch('agent.list'),
        },
        {
          name: 'session.compact',
          title: 'Compact Cuppet conversation and memory',
          desc: 'Compact the active conversation, eligible memory, snapshots, and WAL',
          category: 'Cuppet',
          namespace: 'palette',
          slashName: 'compact',
          run: () => action('Cuppet compact', 'session.compact', {}, 'Conversation and memory compacted.'),
        },
        {
          name: 'session.undo',
          title: 'Undo the latest Cuppet change boundary',
          desc: 'Revert the latest OpenCode change boundary',
          category: 'Cuppet',
          namespace: 'palette',
          slashName: 'undo',
          run: () => action('Cuppet undo', 'session.undo', {}, 'Latest Cuppet change boundary undone.'),
        },
      ],
    })
  },
}

export default CuppetTuiPlugin

export function formatStatus(value: unknown): string {
  const status = record(value)
  const session = record(status.session)
  const foreground = record(status.foreground)
  const foregroundUsage = record(foreground.usage)
  const approval = record(status.approval)
  const background = record(status.background)
  const tst = record(status.tst)
  const project = record(tst.project)
  const global = record(tst.global)
  const graph = record(tst.graph)
  const progress = record(graph.progress)

  const platform = platformName(stringValue(status.platform) ?? 'not selected')
  const sessionTitle = stringValue(session.title)
  const running = booleanValue(foreground.running) ? 'running' : 'idle'
  const steps = numberValue(foreground.steps)
  const foregroundCost = numberValue(foreground.cost)
  const backgroundCost = numberValue(background.cost)
  const warnings = Array.isArray(tst.recovery_warnings) ? tst.recovery_warnings.length : 0
  const tstHealth = stringValue(tst.mode) === 'degraded'
    ? `degraded · ${stringValue(tst.reason) ?? 'daemon unavailable'}`
    : warnings > 0 ? `${warnings} recovery warning${warnings === 1 ? '' : 's'}` : 'healthy'
  const graphState = booleanValue(progress.complete) ? 'ready' : 'indexing'

  return [
    row('Platform', platform),
    ...(sessionTitle ? [row('Session', sessionTitle)] : []),
    row('Primary', modelSummary(status.primary)),
    row('Secondary', modelSummary(status.secondary)),
    row('Approvals', booleanValue(approval.auto) ? 'auto · guarded workspace mode' : 'ask'),
    row('Orchestrator', booleanValue((record(status.orchestrator)).enabled) ? 'master/worker' : 'off'),
    row('State', `${running}${steps === undefined ? '' : ` · ${steps} step${steps === 1 ? '' : 's'}`}`),
    row('Usage', usageSummary(foregroundUsage, foregroundCost)),
    row('Background', backgroundSummary(background, backgroundCost)),
    row('TST', tstHealth),
    row('Memory', `${formatCount(numberValue(project.records))} project · ${formatCount(numberValue(global.records))} global · ${formatCount(numberValue(tst.stm_entries))} recent`),
    row('Graph', `${graphState} · ${formatCount(numberValue(graph.files))} files · ${formatCount(numberValue(graph.symbols))} syms · ${formatCount(numberValue(graph.edges))} edges`),
  ].join('\n')
}

export function formatRemoteControl(value: unknown): string {
  const status = record(value)
  if (!booleanValue(status.running)) return 'Remote control is stopped.'
  const invite = record(status.invite)
  const expiresAt = numberValue(invite.expiresAt)
  return [
    row('Host', `${stringValue(status.deviceName) ?? 'this machine'} · ${stringValue(status.hostId) ?? 'unknown'}`),
    row('Pairing code', stringValue(invite.code) ?? 'not available'),
    ...(stringValue(invite.url) ? [row('Pairing URL', stringValue(invite.url)!)] : []),
    ...(expiresAt ? [row('Expires', new Date(expiresAt).toISOString())] : []),
    row('Relay', stringValue(invite.url) ? 'ready for phone/browser pairing' : 'set CUPPET_RELAY_URL to enable the relay'),
  ].join('\n')
}

export function formatDoctor(value: unknown): string {
  const doctor = record(value)
  const engine = record(doctor.opencode)
  const providers = Array.isArray(engine.providers) ? engine.providers.map(record) : []
  const vertex = record(doctor.vertex)
  const tst = record(doctor.tst)
  const graph = record(tst.graph)
  const progress = record(graph.progress)
  const storage = record(doctor.storage)
  const permissions = record(storage.permissions)
  const checks = Object.values(permissions).map(record)
  const connected = providers.filter((provider) => booleanValue(provider.connected)).length
  const storageReady = checks.filter((check) => booleanValue(check.available)).length
  const tstUnavailable = tst.available === false || stringValue(tst.mode) === 'degraded'

  return [
    row('Runtime', `${stringValue(doctor.runtimeSource) ?? 'unknown'} · ${stringValue(doctor.platform) ?? 'unknown'} · Node ${stringValue(doctor.node) ?? '?'}`),
    row('Engine', booleanValue(engine.available) ? `ready · ${formatCount(numberValue(engine.models))} models · ${formatCount(numberValue(engine.providerCatalogSize))} catalog` : 'unavailable'),
    row('Providers', `${connected}/${providers.length} connected`),
    row('Vertex AI', booleanValue(vertex.connected) ? `connected · ${formatCount(numberValue(vertex.primaryCompatibleModels))} coding models` : 'not connected'),
    row('TST', tstUnavailable ? `degraded · ${stringValue(tst.reason) ?? 'daemon unavailable'}` : `healthy · ${stringValue(tst.protocol) ?? 'protocol ready'}`),
    row('Graph', `${booleanValue(progress.complete) ? 'ready' : 'indexing'} · ${formatCount(numberValue(graph.files))} files · ${formatCount(numberValue(graph.symbols))} syms`),
    row('Storage', `${storageReady}/${checks.length} checks passed`),
  ].join('\n')
}

export function formatMemory(value: unknown): string {
  const status = record(value)
  const tst = record(status.tst)
  const project = record(tst.project)
  const global = record(tst.global)
  const graph = record(tst.graph)
  const progress = record(graph.progress)
  const warnings = Array.isArray(tst.recovery_warnings) ? tst.recovery_warnings.length : 0
  const degraded = stringValue(tst.mode) === 'degraded'
  return [
    row('TST', degraded ? `degraded · ${stringValue(tst.reason) ?? 'daemon unavailable'}` : warnings ? `${warnings} recovery warnings` : 'healthy'),
    row('Project', `${formatCount(numberValue(project.records))} records · ${formatBytes(numberValue(project.wal_bytes))} WAL`),
    row('Global', `${formatCount(numberValue(global.records))} records · ${formatBytes(numberValue(global.wal_bytes))} WAL`),
    row('Recent', `${formatCount(numberValue(tst.stm_entries))} entries · ${formatCount(numberValue(tst.sessions))} sessions`),
    row('Graph', `${booleanValue(progress.complete) ? 'ready' : 'indexing'} · ${formatCount(numberValue(graph.files))} files · ${formatCount(numberValue(graph.symbols))} syms · ${formatCount(numberValue(graph.edges))} edges`),
  ].join('\n')
}

export function removedMessage(value: unknown): string {
  const removed = typeof value === 'number' ? value : numberValue(record(value).removed) ?? 0
  if (removed === 0) return 'No matching memory records found.'
  return `${removed} memory record${removed === 1 ? '' : 's'} removed.`
}

export function planMessage(value: unknown): string {
  const state = record(value)
  const enabled = state.agent === 'plan'
    ? true
    : state.agent === 'build'
      ? false
      : booleanValue(state.enabled)
  return enabled
    ? 'Plan mode enabled.'
    : 'Plan mode disabled.'
}

export function nextPlanAgent(value: string | { id?: string; name?: string } | undefined): 'plan' | 'build' {
  const current = typeof value === 'string' ? value : value?.id ?? value?.name ?? ''
  return current === 'plan' ? 'build' : 'plan'
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function booleanValue(value: unknown): boolean {
  return value === true
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(13)}${shorten(value, 42)}`
}

function shorten(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`
}

function platformName(value: string): string {
  return ({ vertex: 'Vertex AI', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', opencode: 'OpenCode' } as Record<string, string>)[value] ?? value
}

function providerName(value: string): string {
  return ({
    'google-vertex': 'Vertex',
    'google-vertex-anthropic': 'Vertex',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    google: 'Google',
    opencode: 'OpenCode',
  } as Record<string, string>)[value] ?? value
}

function modelSummary(value: unknown): string {
  const model = record(value)
  const id = stringValue(model.modelID)
  if (!id) return 'not configured'
  const variant = stringValue(model.variant)
  const rawName = stringValue(model.name) ?? id
  const name = variant ? rawName.replace(/\s+\[[^\]]+\]$/, '') : rawName
  const provider = stringValue(model.providerID)
  return [name, provider ? providerName(provider) : undefined, variant].filter(Boolean).join(' · ')
}

function usageSummary(usage: Record<string, unknown>, cost: number | undefined): string {
  const input = formatCount(numberValue(usage.input))
  const output = formatCount(numberValue(usage.output))
  const reasoning = numberValue(usage.reasoning)
  return `${input} in · ${output} out${reasoning ? ` · ${formatCount(reasoning)} reasoning` : ''}${cost === undefined ? '' : ` · ${formatMoney(cost)}`}`
}

function backgroundSummary(background: Record<string, unknown>, cost: number | undefined): string {
  if (Object.keys(background).length === 0) return 'not configured'
  const state = booleanValue(background.paused) ? 'paused' : booleanValue(background.running) ? 'running' : 'ready'
  const queued = numberValue(background.queued) ?? 0
  const completed = numberValue(background.completed) ?? 0
  return `${state} · ${queued} queued · ${completed} completed${cost === undefined ? '' : ` · ${formatMoney(cost)}`}`
}

function formatCount(value: number | undefined): string {
  if (value === undefined) return '0'
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return String(value)
}

function formatMoney(value: number): string {
  return `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`
}

function formatBytes(value: number | undefined): string {
  if (value === undefined || value === 0) return '0 B'
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1).replace(/\.0$/, '')} MB`
  if (value >= 1_024) return `${(value / 1_024).toFixed(1).replace(/\.0$/, '')} KB`
  return `${value} B`
}
