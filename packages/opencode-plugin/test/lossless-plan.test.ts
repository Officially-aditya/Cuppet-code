import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { transformCuppetModelContext } from '../src/context.js'
import { createLosslessPlanStore, renderLosslessPlanContext } from '../src/lossless-plan.js'
import { CuppetMemoryPlugin } from '../src/index.js'

function longImplementationPlan(): string {
  const section = (title: string, marker: string) => [
    `# ${title}`,
    ...Array.from({ length: 16 }, (_, index) => `- ${marker} requirement ${index + 1}: retain the exact acceptance detail for this phase.`),
    '',
  ]
  return [
    'Implement this in the stated order. The preamble requirement must remain available to every later phase.',
    '',
    ...section('Foundation', 'Foundation'),
    ...section('Migration', 'Migration'),
    ...section('Validation', 'Validation'),
    ...section('Rollout', 'Rollout'),
  ].join('\n')
}

function structuredNativePlan(): string {
  return [
    '# Discovery',
    '- Map the relevant modules.',
    '- Record constraints before edits.',
    '',
    '# Design',
    '- Specify data ownership.',
    '- Specify rollback behavior.',
    '',
    '# Verification',
    '- Define focused tests.',
    '- Define acceptance evidence.',
  ].join('\n')
}

function userMessage(id: string, text: string) {
  return {
    info: { id, role: 'user' },
    parts: [{ type: 'text', text }],
  }
}

test('lossless plans preserve preambles and full phase detail while restoring omitted todo phases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cuppet-lossless-plan-'))
  try {
    const prompt = longImplementationPlan()
    const store = createLosslessPlanStore(directory)
    const plan = await store.capture({
      sessionID: 'long-plan-session',
      messageID: 'user-long-plan',
      prompt,
      agent: 'cuppet',
    })

    assert.ok(plan)
    assert.equal(plan.sources[0]?.prompt, prompt)
    assert.match(plan.phases.map((phase) => phase.text).join('\n'), /preamble requirement must remain available/)
    const migration = plan.phases.find((phase) => /Migration requirement 16/.test(phase.text))
    assert.ok(migration)

    const first = plan.phases[0]!
    const reconciled = await store.reconcileTodos('long-plan-session', [{
      content: `[${first.id}] Begin the canonical plan`,
      status: 'in_progress',
      priority: 'high',
    }])
    assert.ok(reconciled)
    assert.equal(reconciled.length, plan.phases.length)
    assert.equal(reconciled[0]?.status, 'in_progress')
    assert.deepEqual(
      reconciled.map((todo) => todo.content.match(/\[(P\d+)\]/)?.[1]),
      plan.phases.map((phase) => phase.id),
      'every canonical phase must be restored when TodoWrite omits it',
    )

    const exact = await store.toolResult('long-plan-session', { action: 'phase', phaseID: migration.id })
    assert.ok(exact)
    assert.match(exact.output, /Migration requirement 16/)

    const reloaded = await createLosslessPlanStore(directory).get('long-plan-session')
    assert.equal(reloaded?.sources[0]?.prompt, prompt, 'the raw user specification survives store reloads')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a large phase remains retrievable in exact chunks instead of being silently truncated', async () => {
  const store = createLosslessPlanStore()
  const prompt = [
    '# Foundation',
    `${'detail '.repeat(2_100)}TAIL-FOUNDATION-REQUIREMENT`,
    '# Integration',
    'Preserve the integration contract.',
    '# Verification',
    'Preserve focused acceptance tests.',
  ].join('\n')
  const plan = await store.capture({
    sessionID: 'chunked-phase-session',
    messageID: 'chunked-phase-input',
    prompt,
    agent: 'plan',
  })
  assert.ok(plan)
  const phase = plan.phases[0]!
  const first = await store.toolResult('chunked-phase-session', { action: 'phase', phaseID: phase.id })
  assert.ok(first)
  assert.equal(first.metadata.truncated, true)
  const second = await store.toolResult('chunked-phase-session', { action: 'phase', phaseID: phase.id, offset: 12_000 })
  assert.ok(second)
  assert.equal(second.metadata.truncated, false)
  assert.match(second.output, /TAIL-FOUNDATION-REQUIREMENT/)
})

test('native /plan and build turns share the same canonical plan instead of collapsing it into a todo summary', async () => {
  const store = createLosslessPlanStore()
  const planOutput = { messages: [userMessage('native-plan-input', structuredNativePlan())] }
  await transformCuppetModelContext({
    sessionID: 'native-plan-session',
    agent: 'plan',
    phase: 'foreground',
    history: { estimatedTokens: 1, usableTokens: 20_000 },
  }, planOutput, undefined, store)

  const planContext = String(planOutput.messages[0]?.parts[0]?.text)
  assert.match(planContext, /<CUPPET_LOSSLESS_PLAN canonical="true" agent="plan"/)
  assert.match(planContext, /CANONICAL IMPLEMENTATION PLAN/)

  const buildOutput = { messages: [userMessage('build-input', 'Start implementation with the first phase.')] }
  await transformCuppetModelContext({
    sessionID: 'native-plan-session',
    agent: 'build',
    phase: 'foreground',
    history: { estimatedTokens: 1, usableTokens: 20_000 },
  }, buildOutput, undefined, store)
  const buildContext = String(buildOutput.messages[0]?.parts[0]?.text)
  assert.match(buildContext, /<CUPPET_LOSSLESS_PLAN canonical="true" agent="build"/)
  assert.match(buildContext, /P01/)

  const reminderOnlyOutput = {
    messages: [{
      info: { id: 'native-plan-reminder', role: 'user' },
      parts: [{ type: 'text', text: 'Native plan reminder', synthetic: true }],
    }],
  }
  await transformCuppetModelContext({
    sessionID: 'native-plan-session',
    agent: 'build',
    phase: 'foreground',
    history: { estimatedTokens: 1, usableTokens: 20_000 },
  }, reminderOnlyOutput, undefined, store)
  assert.match(String(reminderOnlyOutput.messages[0]?.parts[0]?.text), /CUPPET_LOSSLESS_PLAN/)

  const plan = await store.get('native-plan-session')
  assert.ok(plan)
  assert.match(renderLosslessPlanContext(plan, 'build'), /Verification/)
})

test('the plugin mutates TodoWrite arguments in place so OpenCode receives the restored checklist', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cuppet-lossless-plugin-'))
  const originalDirectory = process.env.CUPPET_LOSSLESS_PLAN_DIR
  process.env.CUPPET_LOSSLESS_PLAN_DIR = directory
  try {
    const plugin = await CuppetMemoryPlugin()
    const sessionID = 'plugin-todo-session'
    const messages = { messages: [userMessage('plugin-plan-input', longImplementationPlan())] }
    await plugin['experimental.chat.messages.transform']({
      sessionID,
      agent: 'cuppet',
      phase: 'foreground',
      history: { estimatedTokens: 1, usableTokens: 20_000 },
    }, messages)

    const args = {
      todos: [{ content: 'Start with only the first phase', status: 'in_progress', priority: 'high' }],
    }
    await plugin['tool.execute.before']({ tool: 'todowrite', sessionID, callID: 'call-1' }, { args })

    assert.ok(args.todos.length > 1, 'the original TodoWrite argument object must gain the missing phases')
    const phaseIDs = args.todos.map((todo) => todo.content.match(/\[(P\d+)\]/)?.[1]).filter(Boolean)
    assert.ok(phaseIDs.length > 1, 'restored canonical tasks carry stable phase IDs')
    assert.ok(args.todos.some((todo) => todo.content === 'Start with only the first phase'), 'unmatched model work is retained rather than discarded')
    const overview = await plugin.tool.cuppet_plan.execute({ action: 'overview' }, { sessionID })
    assert.notEqual(typeof overview, 'string')
    if (typeof overview !== 'string') assert.match(overview.output, /CANONICAL IMPLEMENTATION PLAN/)
  } finally {
    if (originalDirectory === undefined) delete process.env.CUPPET_LOSSLESS_PLAN_DIR
    else process.env.CUPPET_LOSSLESS_PLAN_DIR = originalDirectory
    await rm(directory, { recursive: true, force: true })
  }
})
