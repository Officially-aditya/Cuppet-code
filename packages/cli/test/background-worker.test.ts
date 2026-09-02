import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BackgroundWorker } from '../src/background/worker.js'
import type { TokenUsage } from '../src/types.js'

const model = { providerID: 'test', modelID: 'secondary' }

test('background batches merge meaningful signals, wait for idle, and persist redacted bounded input', async () => {
  const directory = await temporaryDirectory()
  const gateway = new FakeGateway()
  const tst = new FakeTst()
  const worker = new BackgroundWorker({
    gateway: gateway as never,
    tst: tst as never,
    model,
    projectStore: directory,
    idleDelayMs: 20,
    cooldownMs: 1_000,
  })
  try {
    await worker.ready()
    await worker.recordVerifiedDiff('foreground', `changed API_KEY=secret-value ${'x'.repeat(8_000)}`)
    await worker.recordSuccessfulValidation('foreground', 'npm test')
    const pendingPath = join(directory, 'background-pending.json')
    const pending = await readFile(pendingPath, 'utf8')
    assert.doesNotMatch(pending, /secret-value/)
    assert.ok(Buffer.byteLength(pending) < 8_000)
    assert.equal((await stat(pendingPath)).mode & 0o777, 0o600)
    assert.equal(worker.stats.queued, 1)
    assert.equal(worker.stats.deferred, 1)

    worker.foregroundIdle('foreground')
    await waitFor(() => worker.stats.completed === 1)
    assert.equal(gateway.prompts.length, 1)
    assert.ok(Buffer.byteLength(gateway.prompts[0] ?? '') <= 5_796)
    assert.equal(worker.stats.lastBatch?.candidates, 1)
    assert.equal(worker.stats.lastBatch?.attempts, 1)
    assert.equal(worker.stats.queued, 0)

    await worker.recordSuccessfulValidation('foreground', 'npm test')
    worker.foregroundIdle('foreground')
    await delay(35)
    assert.equal(gateway.prompts.length, 1, 'per-session cooldown prevents a second batch')
    assert.equal(worker.stats.deferred, 1)
  } finally {
    await worker.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('new foreground work cancels and requeues an in-flight batch with a fresh secondary session', async () => {
  const directory = await temporaryDirectory()
  const gateway = new FakeGateway({ holdWait: true })
  const worker = new BackgroundWorker({
    gateway: gateway as never,
    tst: new FakeTst() as never,
    model,
    projectStore: directory,
    idleDelayMs: 1,
    cooldownMs: 0,
  })
  try {
    await worker.ready()
    await worker.recordVerifiedDiff('foreground', 'verified diff')
    worker.foregroundIdle('foreground')
    await waitFor(() => worker.stats.running)
    worker.foregroundStarted()
    await waitFor(() => !worker.stats.running)
    assert.equal(worker.stats.cancellations, 1)
    assert.equal(worker.stats.queued, 1, 'the cancelled batch remains pending')
    assert.equal(worker.stats.completed, 0)

    gateway.holdWait = false
    worker.foregroundIdle('foreground')
    await waitFor(() => worker.stats.completed === 1)
    assert.ok(gateway.createdSessions >= 2, 'every attempt uses a fresh secondary session')
  } finally {
    await worker.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('foreground work arriving during secondary-session creation never prompts that batch', async () => {
  const directory = await temporaryDirectory()
  const gateway = new FakeGateway({ createDelayMs: 20 })
  const worker = new BackgroundWorker({
    gateway: gateway as never,
    tst: new FakeTst() as never,
    model,
    projectStore: directory,
    idleDelayMs: 1,
    cooldownMs: 0,
  })
  try {
    await worker.ready()
    await worker.recordVerifiedDiff('foreground', 'verified diff')
    worker.foregroundIdle('foreground')
    await waitFor(() => worker.stats.running)
    worker.foregroundStarted()
    await waitFor(() => !worker.stats.running)
    assert.equal(gateway.prompts.length, 0)
    assert.equal(worker.stats.queued, 1)
  } finally {
    await worker.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('only one transient transport failure is retried; schema failures are not retried', async () => {
  const directory = await temporaryDirectory()
  const transientGateway = new FakeGateway({ promptFailures: 1 })
  const transient = new BackgroundWorker({
    gateway: transientGateway as never,
    tst: new FakeTst() as never,
    model,
    projectStore: directory,
    idleDelayMs: 1,
    cooldownMs: 0,
  })
  try {
    await transient.ready()
    await transient.recordSuccessfulValidation('foreground', 'npm test')
    transient.foregroundIdle('foreground')
    await waitFor(() => transient.stats.completed === 1)
    assert.equal(transient.stats.attempts, 2)
    assert.equal(transient.stats.lastBatch?.attempts, 2)
  } finally {
    await transient.close()
  }

  const schemaGateway = new FakeGateway({ invalidSchema: true })
  const schema = new BackgroundWorker({
    gateway: schemaGateway as never,
    tst: new FakeTst() as never,
    model,
    projectStore: directory,
    idleDelayMs: 1,
    cooldownMs: 0,
  })
  try {
    await schema.ready()
    await schema.recordSuccessfulValidation('schema-session', 'npm test')
    schema.foregroundIdle('schema-session')
    await waitFor(() => schema.stats.failed === 1)
    assert.equal(schema.stats.attempts, 1)
    assert.equal(schema.stats.lastBatch?.status, 'failed')
  } finally {
    await schema.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('pending batches recover from the private project store after a restart', async () => {
  const directory = await temporaryDirectory()
  const first = new BackgroundWorker({
    gateway: new FakeGateway() as never,
    tst: new FakeTst() as never,
    model,
    projectStore: directory,
    paused: true,
    idleDelayMs: 1,
    cooldownMs: 0,
  })
  try {
    await first.ready()
    await first.recordVerifiedDiff('recovered', 'verified diff before shutdown')
    await first.close()
    const gateway = new FakeGateway()
    const restored = new BackgroundWorker({
      gateway: gateway as never,
      tst: new FakeTst() as never,
      model,
      projectStore: directory,
      idleDelayMs: 1,
      cooldownMs: 0,
    })
    try {
      await restored.ready()
      assert.equal(restored.stats.queued, 1)
      assert.equal(restored.stats.deferred, 1)
      restored.foregroundIdle('new-foreground')
      await waitFor(() => restored.stats.completed === 1)
      assert.equal(gateway.prompts.length, 1)
    } finally {
      await restored.close()
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('turn context remains ephemeral and can create only session-scoped candidates', async () => {
  const directory = await temporaryDirectory()
  const gateway = new FakeGateway({ candidateScope: 'project' })
  const tst = new FakeTst()
  const worker = new BackgroundWorker({
    gateway: gateway as never,
    tst: tst as never,
    model,
    projectStore: directory,
    idleDelayMs: 1,
    cooldownMs: 0,
  })
  try {
    await worker.ready()
    await worker.recordTurnContext('foreground', 'Requirement: preserve native TUI behavior')
    worker.foregroundIdle('foreground')
    await waitFor(() => worker.stats.completed === 1)

    const observation = tst.calls.find((call) => call.method === 'memory.observe')
    assert.equal(observation?.params.scope, 'session', 'unverified turn context must not become project memory')

    await worker.close()
    const pending = JSON.parse(await readFile(join(directory, 'background-pending.json'), 'utf8')) as {
      batches: unknown[]
    }
    assert.deepEqual(pending.batches, [], 'raw turn context must not survive a restart')
  } finally {
    await worker.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('one-off explicit user preference preserves UserPreference evidence without independent promotion', async () => {
  const directory = await temporaryDirectory()
  const gateway = new FakeGateway({
    candidateKey: 'Package manager preference: pnpm',
    candidateValue: 'Prefer pnpm for package management',
    candidateKind: 'preference',
    candidateScope: 'project',
    candidateSourceIDs: ['s1'],
  })
  gateway.userMessages.set('pref-1', 'I prefer pnpm for this repo')
  const tst = new FakeTst()
  const worker = new BackgroundWorker({
    gateway: gateway as never,
    tst: tst as never,
    model,
    projectStore: directory,
    idleDelayMs: 1,
    cooldownMs: 0,
  })
  try {
    await worker.ready()
    await worker.recordTurnContext('pref-1', 'Requirement: choose package manager')
    worker.foregroundIdle('pref-1')
    await waitFor(() => worker.stats.completed === 1)

    const observation = tst.calls.find((call) => call.method === 'memory.observe')
    assert.equal(observation?.params.scope, 'session', 'one-off turn context stays non-durable')
    assert.equal(observation?.params.provenance, 'model_candidate')
    const evidence = tst.calls.filter((call) => call.method === 'evidence.record')
    assert.equal(evidence.filter((call) => call.params.kind === 'user_preference').length, 1)
    assert.equal(evidence.filter((call) => call.params.kind === 'independent_reinforcement').length, 0)
  } finally {
    await worker.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('repeated explicit preference gains deterministic cross-session reinforcement and project admission', async () => {
  const directory = await temporaryDirectory()
  const gateway = new FakeGateway({
    candidateKey: 'Package manager preference: pnpm',
    candidateValue: 'Prefer pnpm for package management',
    candidateKind: 'preference',
    candidateScope: 'project',
    candidateSourceIDs: ['s1'],
  })
  gateway.userMessages.set('pref-1', 'I prefer pnpm for this repo')
  gateway.userMessages.set('pref-2', 'Please use pnpm here too')
  const tst = new FakeTst()
  const worker = new BackgroundWorker({
    gateway: gateway as never,
    tst: tst as never,
    model,
    projectStore: directory,
    idleDelayMs: 1,
    cooldownMs: 0,
  })
  try {
    await worker.ready()
    await worker.recordTurnContext('pref-1', 'Requirement: choose package manager')
    worker.foregroundIdle('pref-1')
    await waitFor(() => worker.stats.completed === 1)

    await worker.recordTurnContext('pref-2', 'Requirement: choose package manager')
    worker.foregroundIdle('pref-2')
    await waitFor(() => worker.stats.completed === 2)

    const observations = tst.calls.filter((call) => call.method === 'memory.observe')
    assert.equal(observations.length, 2)
    assert.equal(observations[0]?.params.scope, 'session')
    assert.equal(observations[1]?.params.scope, 'project')
    const secondMemoryID = observations[1]?.resultID
    const secondEvidence = tst.calls.filter(
      (call) => call.method === 'evidence.record' && call.params.memory_id === secondMemoryID,
    )
    assert.equal(secondEvidence.filter((call) => call.params.kind === 'user_preference').length, 1)
    assert.equal(secondEvidence.filter((call) => call.params.kind === 'independent_reinforcement').length, 2)

    const ledger = JSON.parse(await readFile(join(directory, 'candidate-ledger.json'), 'utf8')) as {
      entries: Array<{ explicit_user_count: number; session_count: number; support_count: number }>
    }
    assert.equal(ledger.entries[0]?.explicit_user_count, 2)
    assert.equal(ledger.entries[0]?.session_count, 2)
    assert.equal(ledger.entries[0]?.support_count, 2)
  } finally {
    await worker.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('trusted user contradiction blocks admission and forgets the exact canonical memory', async () => {
  const directory = await temporaryDirectory()
  const gateway = new FakeGateway({
    candidateKey: 'Package manager preference: pnpm',
    candidateValue: 'Prefer pnpm for package management',
    candidateKind: 'preference',
    candidateScope: 'project',
    candidateSourceIDs: ['s1'],
  })
  gateway.userMessages.set('pref-1', 'I prefer pnpm')
  gateway.userMessages.set('pref-2', 'Please use pnpm here too')
  gateway.userMessages.set('pref-3', 'Never use pnpm here')
  const tst = new FakeTst()
  const worker = new BackgroundWorker({
    gateway: gateway as never,
    tst: tst as never,
    model,
    projectStore: directory,
    idleDelayMs: 1,
    cooldownMs: 0,
  })
  try {
    await worker.ready()
    for (const sessionID of ['pref-1', 'pref-2']) {
      await worker.recordTurnContext(sessionID, 'Requirement: choose package manager')
      worker.foregroundIdle(sessionID)
      await waitFor(() => worker.stats.completed >= Number(sessionID.at(-1)))
    }

    gateway.candidateRelation = 'contradiction'
    await worker.recordTurnContext('pref-3', 'Requirement changed')
    worker.foregroundIdle('pref-3')
    await waitFor(() => worker.stats.completed === 3)

    const forget = tst.calls.find((call) => call.method === 'memory.forget')
    assert.equal(forget?.params.key, 'Package manager preference: pnpm')
    assert.equal(tst.calls.filter((call) => call.method === 'memory.observe').length, 2)
  } finally {
    await worker.close()
    await rm(directory, { recursive: true, force: true })
  }
})

class FakeGateway {
  readonly prompts: string[] = []
  readonly sessions = new Map<string, { tokens: TokenUsage; cost: number }>()
  readonly waiters = new Map<string, () => void>()
  readonly userMessages = new Map<string, string>()
  createdSessions = 0
  holdWait: boolean
  promptFailures: number
  invalidSchema: boolean
  createDelayMs: number
  candidateScope: 'session' | 'project'
  candidateKind: 'token_statistics' | 'concept_anchor' | 'structure_pattern' | 'behavioral_claim' | 'preference'
  candidateKey: string
  candidateValue: string
  candidateSourceIDs: string[]
  candidateRelation: 'support' | 'correction' | 'contradiction'

  constructor(options: {
    holdWait?: boolean
    promptFailures?: number
    invalidSchema?: boolean
    createDelayMs?: number
    candidateScope?: 'session' | 'project'
    candidateKind?: 'token_statistics' | 'concept_anchor' | 'structure_pattern' | 'behavioral_claim' | 'preference'
    candidateKey?: string
    candidateValue?: string
    candidateSourceIDs?: string[]
    candidateRelation?: 'support' | 'correction' | 'contradiction'
  } = {}) {
    this.holdWait = options.holdWait ?? false
    this.promptFailures = options.promptFailures ?? 0
    this.invalidSchema = options.invalidSchema ?? false
    this.createDelayMs = options.createDelayMs ?? 0
    this.candidateScope = options.candidateScope ?? 'project'
    this.candidateKind = options.candidateKind ?? 'concept_anchor'
    this.candidateKey = options.candidateKey ?? 'verified signal'
    this.candidateValue = options.candidateValue ?? 'durable candidate'
    this.candidateSourceIDs = options.candidateSourceIDs ?? []
    this.candidateRelation = options.candidateRelation ?? 'support'
  }

  async createSession() {
    if (this.createDelayMs > 0) await delay(this.createDelayMs)
    const id = `background-${++this.createdSessions}`
    const session = { tokens: emptyUsage(), cost: 0 }
    this.sessions.set(id, session)
    return { id, title: id, cost: 0, tokens: { ...session.tokens }, updated: Date.now() }
  }

  async getSession(id: string) {
    const session = this.sessions.get(id) ?? { tokens: emptyUsage(), cost: 0 }
    return { id, title: id, cost: session.cost, tokens: { ...session.tokens }, updated: Date.now() }
  }

  async prompt(id: string, prompt: string) {
    this.prompts.push(prompt)
    if (this.promptFailures > 0) {
      this.promptFailures -= 1
      throw new Error('ECONNRESET secondary transport')
    }
    const session = this.sessions.get(id)
    if (session) {
      session.tokens.output += 12
      session.cost += 0.01
    }
  }

  async wait(id: string) {
    if (!this.holdWait) return
    await new Promise<void>((resolve) => this.waiters.set(id, resolve))
  }

  async messages(id: string) {
    if (!id.startsWith('background-')) {
      const text = this.userMessages.get(id)
      return text
        ? [{ info: { id: `user-${id}`, role: 'user' }, parts: [{ type: 'text', text }] }]
        : []
    }
    return [this.invalidSchema
      ? 'not structured output'
      : JSON.stringify({
          candidates: [{
            key: this.candidateKey,
            value: this.candidateValue,
            kind: this.candidateKind,
            scope: this.candidateScope,
            ...(this.candidateSourceIDs.length > 0 ? { source_ids: this.candidateSourceIDs } : {}),
            ...(this.candidateRelation !== 'support' ? { relation: this.candidateRelation } : {}),
          }],
        })]
  }

  async interrupt(id: string) {
    this.waiters.get(id)?.()
    this.waiters.delete(id)
  }
}

class FakeTst {
  #nextID = 0
  readonly calls: Array<{ method: string; params: Record<string, unknown>; resultID?: string }> = []

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (method === 'memory.observe') {
      const id = `memory-${++this.#nextID}`
      this.calls.push({ method, params, resultID: id })
      return { id } as T
    }
    this.calls.push({ method, params })
    if (method === 'memory.forget') return { removed: 1 } as T
    return { recorded: true } as T
  }
}

function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'cuppet-background-test-'))
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(2)
  }
  throw new Error('condition did not become true before timeout')
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
