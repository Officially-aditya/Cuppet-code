/* Cuppet Remote PWA — vanilla JS client for the self-hosted relay. */
(() => {
  'use strict'

  const $ = (id) => document.getElementById(id)

  function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  // ---------- state ----------
  let params = new URLSearchParams(location.search)
  let hostId = params.get('host') ?? localStorage.getItem('cuppet.host') ?? ''
  let creds = null // { deviceId, secret }
  let ws = null
  let authed = false
  let closedByUs = false
  let reconnectAttempt = 0
  let reconnectTimer = null
  let lastEventSeq = 0
  let attachConnectionId = null
  let attachedOnce = false
  let resyncTimer = null

  let snapshot = null
  let sessions = []
  let activeSessionID = null
  const liveTools = new Map() // callID -> {card, stateIcon, titleNode, bodyNode}
  let liveAssistant = null
  const pendingCommands = new Map()
  let commandCounter = 0

  // ---------- tiny helpers ----------
  function wsBase() {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
  }

  function setDot(mode) {
    const dot = $('conn-dot')
    dot.className = `dot ${mode}`
  }

  function setStatus(text) {
    $('usage-line').textContent = text
  }

  function randomName() {
    const animals = ['otter', 'falcon', 'heron', 'lynx', 'marten', 'puffin']
    return `${animals[Math.floor(Math.random() * animals.length)]}-${Math.floor(Math.random() * 900 + 100)}`
  }

  function sendRaw(value) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value))
  }

  function command(type, payload = {}) {
    return new Promise((resolvePromise, rejectPromise) => {
      const id = `c${Date.now().toString(36)}-${commandCounter += 1}`
      const timer = setTimeout(() => {
        pendingCommands.delete(id)
        rejectPromise(new Error(`${type} timed out`))
      }, 10_000)
      pendingCommands.set(id, { resolve: resolvePromise, timer })
      sendRaw({ version: 1, id, type, ts: Date.now(), payload })
    })
  }

  // ---------- pairing ----------
  async function pair(code, deviceName) {
    const placeholder = `pair-${Math.random().toString(36).slice(2, 10)}`
    return new Promise((resolvePromise, rejectPromise) => {
      const socket = new WebSocket(`${wsBase()}?role=device&hostId=${encodeURIComponent(hostId)}&deviceId=${placeholder}`)
      let settled = false
      socket.addEventListener('open', () => {
        $('pair-status').textContent = 'connected — redeeming code…'
        socket.send(JSON.stringify({ version: 1, type: 'device.pair', ts: Date.now(), payload: { code, name: deviceName } }))
      })
      socket.addEventListener('message', (event) => {
        try {
          const frame = JSON.parse(event.data)
          if (frame.replyTo === 'device-pair') {
            settled = true
            if (frame.ok) resolvePromise(frame.result)
            else rejectPromise(new Error(frame.error ?? 'pairing failed'))
            socket.close()
          }
        } catch { /* ignore */ }
      })
      socket.addEventListener('close', () => {
        if (!settled) rejectPromise(new Error('connection closed during pairing'))
      })
      socket.addEventListener('error', () => {
        if (!settled) rejectPromise(new Error('relay unreachable'))
      })
    })
  }

  // ---------- connection ----------
  function connect() {
    clearTimeout(reconnectTimer)
    if (!hostId || !creds) return
    closedByUs = false
    setDot('off')
    const url =
      `${wsBase()}?role=device&hostId=${encodeURIComponent(hostId)}` +
      `&deviceId=${encodeURIComponent(creds.deviceId)}&secret=${encodeURIComponent(creds.secret)}`
    ws = new WebSocket(url)
    ws.addEventListener('open', () => { /* hello comes from the relay automatically */ })
    ws.addEventListener('message', (event) => {
      let frame
      try { frame = JSON.parse(event.data) } catch { return }
      handleFrame(frame)
    })
    ws.addEventListener('close', (event) => {
      authed = false
      if (closedByUs) return
      setDot('err')
      setStatus(event.code === 4001 ? 'host offline — waiting for your machine to connect' : 'reconnecting…')
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(reconnectAttempt += 1, 5))
      reconnectTimer = setTimeout(connect, delay)
    })
    ws.addEventListener('error', () => { /* close handler drives retries */ })
  }

  function handleFrame(frame) {
    if (frame.replyTo !== undefined) {
      if (frame.replyTo === 'device-hello') {
        if (frame.ok) {
          authed = true
          reconnectAttempt = 0
          setDot('on')
          requestBootstrap().catch(() => undefined)
        } else {
          showPair(`Credentials rejected: ${frame.error ?? 'unknown'}`)
          localStorage.removeItem(`cuppet.device.${hostId}`)
          creds = null
          closedByUs = true
          try { ws.close() } catch { /* ignore */ }
        }
        return
      }
      const entry = pendingCommands.get(frame.replyTo)
      if (entry) {
        clearTimeout(entry.timer)
        pendingCommands.delete(frame.replyTo)
        frame.ok ? entry.resolve(frame.result) : entry.reject(new Error(frame.error ?? 'command failed'))
      }
      return
    }
    if (frame.type === 'host.attach' && typeof frame.payload?.connectionId === 'string') {
      if (attachConnectionId !== null && attachConnectionId !== frame.payload.connectionId) {
        lastEventSeq = 0
      }
      attachConnectionId = frame.payload.connectionId
    }
    if (typeof frame.seq === 'number' && frame.seq > 0) {
      if (attachedOnce && frame.seq <= lastEventSeq) return // replay duplicate
      if (attachedOnce && frame.seq > lastEventSeq + 1) scheduleResync()
      lastEventSeq = frame.seq
    }
    switch (frame.type) {
      case 'client.reject':
        showPair('The host rejected this device.')
        break
      case 'host.attach':
        attachedOnce = true
        if (frame.payload?.snapshot) applySnapshot(frame.payload.snapshot)
        renderPending(frame.payload?.permissions ?? [], frame.payload?.questions ?? [])
        reloadTranscript()
        break
      case 'assistant.text.delta': ensureLiveAssistant().appendText(String(frame.payload?.text ?? '')); break
      case 'assistant.reasoning.delta': ensureLiveAssistant().appendReasoning(String(frame.payload?.text ?? '')); break
      case 'tool.started': addToolCard(String(frame.payload?.callID ?? ''), frame.payload); break
      case 'tool.progress': progressToolCard(frame.payload); break
      case 'tool.completed': completeToolCard(frame.payload); break
      case 'diff.updated': addDiffCard(frame.payload?.diff); break
      case 'permission.requested': onPermissionRequested(frame.payload?.request); break
      case 'permission.resolved': onPermissionResolved(String(frame.payload?.requestID ?? '')); break
      case 'question.requested': onQuestionRequested(frame.payload?.request); break
      case 'question.resolved': onQuestionResolved(String(frame.payload?.requestID ?? '')); break
      case 'session.idle': finalizeLiveAssistant(); break
      case 'usage.updated': renderUsage(frame.payload); break
      case 'compaction': addSystemNote(`compaction: ${frame.payload?.phase ?? ''}`); break
      case 'agent.error': addErrorNote(String(frame.payload?.message ?? 'agent error')); break
      case 'step.limit': addSystemNote(`step limit reached (${frame.payload?.steps ?? '?'})`); break
      case 'host.snapshot':
        if (frame.payload) { applySnapshot(frame.payload); refreshSessionsQuietly() }
        break
      default: break
    }
  }

  function scheduleResync() {
    clearTimeout(resyncTimer)
    resyncTimer = setTimeout(async () => {
      try {
        const snap = await command('session.snapshot')
        if (snap) applySnapshot(snap)
        await refreshSessions()
      } catch { /* retried on next gap */ }
    }, 500)
  }

  async function requestBootstrap() {
    try {
      const snap = await command('session.snapshot')
      if (snap) applySnapshot(snap)
      await refreshSessions()
      await refreshPendingLists()
    } catch { /* attach frame usually covers this */ }
  }

  // ---------- snapshot / sessions ----------
  function applySnapshot(snap) {
    snapshot = snap
    const sessionTitle = snap.activeSession?.title ?? 'No active session'
    $('host-name').textContent = `Host ${hostId.replace(/^host_/, '').slice(0, 8)} · ${sessionTitle}`
    $('busy-badge').classList.toggle('hidden', !snap.running)
    $('abort-button').classList.toggle('hidden', !snap.running)
    $('plan-toggle').style.borderColor = snap.planMode ? 'var(--accent)' : ''
    renderModelSelect(snap)
    renderUsage({ usage: snap.foregroundUsage, cost: snap.foregroundCost })
  }

  function renderModelSelect(snap) {
    const select = $('model-select')
    const models = Array.isArray(snap.models) ? snap.models.filter((m) => m && m.enabled !== false) : []
    const nextValue = snap.primary ? `${snap.primary.providerID}|${snap.primary.modelID}` : ''
    // Rebuild only when the model set or selection actually changed, so an
    // open dropdown is not slammed shut by every streaming snapshot.
    const signature = JSON.stringify([models.map((m) => `${m.providerID}|${m.modelID}`), nextValue])
    if (select.dataset.signature === signature) return
    select.dataset.signature = signature
    select.innerHTML = ''
    for (const model of models) {
      const option = el('option', '', `${model.providerID}/${model.modelID}`)
      option.value = `${model.providerID}|${model.modelID}`
      select.appendChild(option)
    }
    if (snap.primary) select.value = nextValue
    select.onchange = async () => {
      const [providerID, modelID] = String(select.value).split('|')
      try { await command('model.select', { providerID, modelID }) } catch { /* surfaced via snapshot */ }
    }
  }

  function renderUsage(payload) {
    const usage = payload?.usage ?? {}
    const cost = payload?.cost
    const tokens = (usage.input ?? usage.inputTokens ?? 0) + (usage.output ?? usage.outputTokens ?? 0)
    setStatus(`${tokens.toLocaleString()} tok${typeof cost === 'number' ? ` · $${cost.toFixed(3)}` : ''}`)
  }

  async function refreshSessions() {
    const list = await command('session.list').catch(() => null)
    if (!Array.isArray(list)) return
    sessions = list.filter((s) => s && typeof s.id === 'string')
    const select = $('session-select')
    const activeID = snapshot?.activeSession?.id ?? ''
    // Skip rebuilding when nothing changed so an open dropdown stays open.
    const signature = JSON.stringify([sessions.map((s) => [s.id, s.title]), activeID])
    if (select.dataset.signature === signature) return
    select.dataset.signature = signature
    select.innerHTML = ''
    for (const session of sessions) {
      const option = el('option', '', session.title || session.id.slice(0, 12))
      option.value = session.id
      select.appendChild(option)
    }
    if (activeID && sessions.some((s) => s.id === activeID)) select.value = activeID
    if (select.value !== activeSessionID) {
      activeSessionID = select.value
      reloadTranscript()
    }
    select.onchange = async () => {
      activeSessionID = select.value
      clearTranscript()
      try { await command('session.resume', { sessionID: activeSessionID }) } catch { /* ignore */ }
      reloadTranscript()
    }
  }

  function refreshSessionsQuietly() {
    if (!authed) return
    refreshSessions().catch(() => undefined)
  }

  async function refreshPendingLists() {
    const [permissions, questions] = await Promise.all([
      command('permission.list').catch(() => []),
      command('question.list').catch(() => []),
    ])
    renderPending(Array.isArray(permissions) ? permissions : [], Array.isArray(questions) ? questions : [])
  }

  // ---------- transcript ----------
  function transcriptEl() { return $('transcript') }

  function clearTranscript() {
    transcriptEl().innerHTML = ''
    liveTools.clear()
    liveAssistant = null
  }

  function scrollToEnd() {
    const main = transcriptEl()
    main.scrollTop = main.scrollHeight
  }

  function ensureLiveAssistant() {
    if (!liveAssistant || !liveAssistant.node.isConnected) {
      const node = el('div', 'bubble assistant')
      const textNode = el('span', 'text')
      const reasoningNode = el('span', 'reasoning')
      node.append(reasoningNode, textNode)
      transcriptEl().appendChild(node)
      liveAssistant = {
        node, textNode, reasoningNode,
        appendText(t) { textNode.textContent += t; scrollToEnd() },
        appendReasoning(t) { reasoningNode.textContent += t; scrollToEnd() },
      }
    }
    return liveAssistant
  }

  function finalizeLiveAssistant() {
    if (liveAssistant && !liveAssistant.textNode.textContent && !liveAssistant.reasoningNode.textContent) {
      liveAssistant.node.remove()
    }
  }

  function addUserBubble(text) {
    transcriptEl().appendChild(el('div', 'bubble user', text))
    scrollToEnd()
  }

  function addSystemNote(text) {
    transcriptEl().appendChild(el('div', 'muted', `— ${text}`))
    scrollToEnd()
  }

  function addErrorNote(text) {
    const note = el('div', '', '')
    note.style.cssText = 'color: var(--danger); font-size: 13px;'
    note.textContent = `⚠ ${text}`
    transcriptEl().appendChild(note)
    scrollToEnd()
  }

  function makeCard(titleText, stateText) {
    const card = el('div', 'card')
    const head = el('div', 'card-head')
    const stateIcon = el('span', 'state-icon', stateText ?? '▸')
    const title = el('span', 'card-title', titleText)
    head.append(stateIcon, title)
    const body = el('div', 'card-body')
    body.hidden = true
    head.addEventListener('click', () => { body.hidden = !body.hidden })
    card.append(head, body)
    transcriptEl().appendChild(card)
    scrollToEnd()
    return { card, stateIcon, title, body }
  }

  function preview(value, max = 300) {
    if (value === undefined || value === null) return ''
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1)
    return text.length > max ? `${text.slice(0, max)}…` : text
  }

  function addToolCard(callID, payload) {
    finalizeLiveAssistant()
    const parts = [payload?.name ?? 'tool']
    const inputPreview = preview(payload?.input, 160)
    if (inputPreview) parts.push(inputPreview.split('\n')[0])
    const ui = makeCard(parts.join(' — '), '▸')
    if (inputPreview) ui.body.appendChild(el('pre', '', inputPreview))
    liveTools.set(callID, ui)
  }

  function progressToolCard(payload) {
    const ui = liveTools.get(String(payload?.callID ?? ''))
    if (!ui) return
    ui.stateIcon.textContent = '⠿'
    if (payload?.message) {
      ui.body.innerHTML = ''
      ui.body.appendChild(el('pre', '', preview(payload.message)))
    }
  }

  function completeToolCard(payload) {
    const callID = String(payload?.callID ?? '')
    const ui = liveTools.get(callID)
    if (!ui) return
    ui.stateIcon.textContent = payload?.success ? '✓' : '✗'
    ui.stateIcon.style.color = payload?.success ? 'var(--ok)' : 'var(--danger)'
    ui.body.innerHTML = ''
    if (typeof payload?.diff === 'string' && payload.diff) {
      ui.title.textContent = `${payload.name ?? 'tool'} · diff`
      ui.body.appendChild(el('pre', '', payload.diff))
      ui.body.hidden = false
    } else if (payload?.output !== undefined) {
      ui.body.appendChild(el('pre', '', preview(payload.output)))
    }
    liveTools.delete(callID)
  }

  function addDiffCard(diff) {
    const text = typeof diff === 'string' ? diff : JSON.stringify(diff, null, 1)
    if (!text || text === '[]') return
    const ui = makeCard('diff updated', '±')
    ui.body.hidden = false
    ui.body.appendChild(el('pre', '', preview(text, 8000)))
  }

  let transcriptGeneration = 0

  async function reloadTranscript() {
    const generation = transcriptGeneration += 1
    if (!activeSessionID) return
    const messages = await command('session.messages', { sessionID: activeSessionID }).catch(() => null)
    // A newer reload (session switch, reconnect) supersedes this one.
    if (generation !== transcriptGeneration || !Array.isArray(messages)) return
    clearTranscript()
    for (const message of messages) renderHistoricalMessage(message)
    scrollToEnd()
  }

  function renderHistoricalMessage(message) {
    const parts = Array.isArray(message?.parts) ? message.parts : []
    for (const part of parts) {
      if (part?.type === 'text' && part.text) {
        transcriptEl().appendChild(el('div', `bubble ${message.role === 'user' ? 'user' : 'assistant'}`, part.text))
      } else if (part?.type === 'reasoning' && part.text) {
        const bubble = el('div', 'bubble assistant')
        bubble.appendChild(el('span', 'reasoning', part.text))
        transcriptEl().appendChild(bubble)
      } else if (part?.type === 'tool') {
        const status = part.state?.status ?? 'done'
        const ok = status === 'completed' || status === 'done'
        const ui = makeCard(part.tool ?? 'tool', ok ? '✓' : status === 'error' ? '✗' : '▸')
        const output = part.state?.output ?? part.state?.title
        if (output) ui.body.appendChild(el('pre', '', preview(output)))
      }
    }
  }

  // ---------- permissions & questions ----------
  function pendingEl() { return $('pending') }

  function renderPending(permissions, questions) {
    pendingEl().innerHTML = ''
    for (const request of permissions ?? []) renderPermissionCard(request)
    for (const request of questions ?? []) renderQuestionCard(request)
  }

  function onPermissionRequested(request) {
    if (!request?.id) return
    if (document.querySelector(`[data-permission="${CSS.escape(request.id)}"]`)) return
    renderPermissionCard(request)
  }

  function renderPermissionCard(request) {
    finalizeLiveAssistant()
    const card = el('div', 'pending-card')
    card.dataset.permission = request.id
    card.appendChild(el('h3', '', 'Permission required'))
    card.appendChild(el('div', 'action-line', String(request.action ?? 'unknown action')))
    for (const resource of request.resources ?? []) {
      card.appendChild(el('div', 'action-line muted', preview(resource, 120)))
    }

    const actions = el('div', 'actions')
    const dismiss = () => card.remove()
    const reply = (value) => {
      command('permission.reply', {
        request: { id: request.id, sessionID: request.sessionID },
        reply: value,
      }).catch(() => undefined)
      dismiss()
    }
    actions.appendChild(Object.assign(el('button', 'danger', 'Reject'), { onclick: () => reply('reject') }))
    actions.appendChild(Object.assign(el('button', '', 'Allow once'), { onclick: () => reply('once') }))
    if ((request.save ?? []).includes('always')) {
      actions.appendChild(Object.assign(el('button', 'primary', 'Always'), { onclick: () => reply('always') }))
    }
    card.appendChild(actions)
    pendingEl().appendChild(card)
    card.scrollIntoView({ block: 'nearest' })
  }

  function onPermissionResolved(requestID) {
    document.querySelector(`[data-permission="${CSS.escape(requestID)}"]`)?.remove()
  }

  function onQuestionRequested(request) {
    if (!request?.id) return
    if (document.querySelector(`[data-question="${CSS.escape(request.id)}"]`)) return
    renderQuestionCard(request)
  }

  function renderQuestionCard(request) {
    finalizeLiveAssistant()
    const card = el('div', 'pending-card')
    card.dataset.question = request.id
    card.appendChild(el('h3', '', 'Cuppet needs your input'))

    // One answer array per question; checkboxes accumulate multiple labels.
    const selections = []
    for (const [index, question] of (request.questions ?? []).entries()) {
      const block = el('div', '')
      block.appendChild(el('strong', '', question.header || question.question || `Question ${index + 1}`))
      selections[index] = []
      for (const option of question.options ?? []) {
        const label = el('label', 'opt')
        const input = el('input')
        input.type = question.multiple ? 'checkbox' : 'radio'
        input.name = `${request.id}-${index}`
        input.value = option.label ?? ''
        input.addEventListener('change', () => {
          if (question.multiple) {
            if (input.checked) selections[index].push(option.label ?? '')
            else selections[index] = selections[index].filter((v) => v !== option.label)
          } else {
            selections[index] = [option.label ?? '']
          }
        })
        label.append(input, el('span', '', `${option.label}${option.description ? ` — ${option.description}` : ''}`))
        block.appendChild(label)
      }
      card.appendChild(block)
    }

    const actions = el('div', 'actions')
    actions.appendChild(Object.assign(el('button', 'danger', 'Reject'), {
      onclick: () => {
        command('question.reject', { requestID: request.id }).catch(() => undefined)
        card.remove()
      },
    }))
    actions.appendChild(Object.assign(el('button', 'primary', 'Submit'), {
      onclick: () => {
        command('question.reply', { requestID: request.id, answers: selections }).catch(() => undefined)
        card.remove()
      },
    }))
    card.appendChild(actions)
    pendingEl().appendChild(card)
    card.scrollIntoView({ block: 'nearest' })
  }

  function onQuestionResolved(requestID) {
    document.querySelector(`[data-question="${CSS.escape(requestID)}"]`)?.remove()
  }

  // ---------- composer & controls ----------
  function wireControls() {
    const send = async () => {
      const input = $('composer-input')
      const text = input.value.trim()
      if (!text || !authed) return
      input.value = ''
      addUserBubble(text)
      try {
        if (snapshot?.running) {
          await command('session.steer', { instruction: text })
        } else {
          await command('session.submit', { prompt: text, delivery: 'queue' })
        }
      } catch (error) {
        addErrorNote(String(error.message ?? error))
      }
    }
    $('send-button').addEventListener('click', send)
    $('composer-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        void send()
      }
    })

    $('abort-button').addEventListener('click', () => command('session.abort').catch(() => undefined))
    $('undo-button').addEventListener('click', () => command('session.undo').catch(() => undefined))
    $('compact-button').addEventListener('click', () => command('session.compact').catch(() => undefined))
    $('new-session').addEventListener('click', async () => {
      try {
        await command('session.new')
        await refreshSessions()
        clearTranscript()
      } catch { /* ignore */ }
    })
    $('plan-toggle').addEventListener('click', () => {
      const target = snapshot?.planMode ? 'build' : 'plan'
      command('plan.set', { agent: target }).catch(() => undefined)
    })
    $('refresh-button').addEventListener('click', () => {
      refreshSessions().catch(() => undefined)
      refreshPendingLists().catch(() => undefined)
    })
  }

  // ---------- screens ----------
  function showApp() {
    $('pair-screen').classList.add('hidden')
    $('app-screen').classList.remove('hidden')
    wireControls()
    connect()
  }

  function showPair(message) {
    if (!$('app-screen').classList.contains('hidden')) {
      $('app-screen').classList.add('hidden')
      $('pair-screen').classList.remove('hidden')
    }
    $('pair-error').textContent = message ?? ''
    $('pair-status').textContent = ''
    $('pair-button').disabled = false
  }

  async function init() {
    params = new URLSearchParams(location.search)
    hostId = params.get('host') ?? localStorage.getItem('cuppet.host') ?? ''
    if (!hostId) {
      showPair('Missing host id — scan the QR code shown by `cuppet remote-control`.')
      return
    }
    localStorage.setItem('cuppet.host', hostId)
    creds = JSON.parse(localStorage.getItem(`cuppet.device.${hostId}`) ?? 'null')

    $('pair-code').value = params.get('code') ?? ''
    $('pair-name').value = localStorage.getItem('cuppet.deviceName') ?? randomName()

    if (creds && !params.get('code')) {
      showApp()
      return
    }

    $('pair-button').addEventListener('click', async () => {
      const code = $('pair-code').value.trim().toUpperCase()
      const name = $('pair-name').value.trim() || randomName()
      if (!code) {
        $('pair-error').textContent = 'Enter the pairing code shown on your machine.'
        return
      }
      $('pair-button').disabled = true
      $('pair-error').textContent = ''
      $('pair-status').textContent = 'connecting…'
      try {
        const result = await pair(code, name)
        localStorage.setItem('cuppet.deviceName', name)
        localStorage.setItem(`cuppet.device.${hostId}`, JSON.stringify(result))
        creds = result
        showApp()
      } catch (error) {
        showPair(error.message ?? String(error))
      }
    })
  }

  window.addEventListener('beforeunload', () => {
    closedByUs = true
    try { ws?.close() } catch { /* ignore */ }
  })

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/app/sw.js').catch(() => undefined)
  }

  init().catch((error) => showPair(String(error)))
})()
