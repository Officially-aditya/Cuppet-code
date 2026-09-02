import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  PE3_MAX_PERSISTED_AGENTS,
  Pe3TaskRegistry,
  restorePersistedTaskAgents,
} from '../src/pe3/persistence.js'
import { SemanticTaskRouter, type TaskEmbeddingProvider } from '../src/pe3/semantic-router.js'
import { TaskSessionRouter, type TaskSessionAdapter } from '../src/pe3/session-router.js'
import type { TaskAgentState } from '../src/pe3/task-agents.js'

test('multiple task identities survive restart and dormant auth reactivates without reopening it first', async () => {
  const fixture = await fixtureDir()
  try {
    const original = new TaskSessionRouter(undefined, { semantic: false })
    const before = adapterHarness()
    const auth = await original.prepare('fix auth refresh token expiration in src/auth/token.ts', before.adapter)
    const analytics = await original.prepare('separately, new task: add analytics csv export in src/analytics/export.ts', before.adapter)
    assert.notEqual(auth.sessionID, analytics.sessionID)

    const registry = new Pe3TaskRegistry(fixture.store, fixture.root)
    await registry.save(original.agents(), analytics.sessionID)

    const loaded = await registry.load(new Set([auth.sessionID, analytics.sessionID]))
    const restored = new TaskSessionRouter(undefined, { semantic: false })
    restorePersistedTaskAgents(restored, loaded, analytics.sessionID)
    const after = adapterHarness(analytics.sessionID)
    const resumed = await restored.prepare('go back to auth refresh token', after.adapter)

    assert.equal(restored.agents().length, 2)
    assert.equal(resumed.action, 'reactivate')
    assert.equal(resumed.sessionID, auth.sessionID)
    assert.deepEqual(after.resumed, [auth.sessionID])
  } finally {
    await fixture.cleanup()
  }
})

test('restore is inert and does not invoke semantic inference merely to reconstruct dormant agents', async () => {
  const fixture = await fixtureDir()
  try {
    const registry = new Pe3TaskRegistry(fixture.store, fixture.root)
    await registry.save([
      fakeAgent('s1', 'auth refresh token', 1),
      fakeAgent('s2', 'analytics export', 2),
    ], 's2')
    const loaded = await registry.load(new Set(['s1', 's2']))
    let modelCalls = 0
    const provider: TaskEmbeddingProvider = {
      modelID: 'must-not-run-on-restore',
      embed: async () => {
        modelCalls += 1
        throw new Error('restore executed a model')
      },
    }
    const router = new TaskSessionRouter(undefined, {
      semantic: new SemanticTaskRouter(provider),
    })

    restorePersistedTaskAgents(router, loaded, 's2')

    assert.equal(modelCalls, 0)
    assert.equal(router.agents().length, 2)
    assert.equal(router.active?.sessionID, 's2')
  } finally {
    await fixture.cleanup()
  }
})

test('corrupt or missing registry fails open to a fresh task registry', async () => {
  const fixture = await fixtureDir()
  try {
    const registry = new Pe3TaskRegistry(fixture.store, fixture.root)
    const missing = await registry.load(new Set(['s1']))
    assert.deepEqual(missing.agents, [])
    assert.equal(missing.recoveredFromCorruption, false)

    await mkdir(fixture.store, { recursive: true })
    await writeFile(registry.path, '{ definitely not json', 'utf8')
    const corrupt = await registry.load(new Set(['s1']))
    assert.deepEqual(corrupt.agents, [])
    assert.equal(corrupt.recoveredFromCorruption, true)
  } finally {
    await fixture.cleanup()
  }
})

test('deleted OpenCode sessions are ignored and disappear on the next persisted snapshot', async () => {
  const fixture = await fixtureDir()
  try {
    const registry = new Pe3TaskRegistry(fixture.store, fixture.root)
    await registry.save([
      fakeAgent('deleted', 'old deleted task', 1),
      fakeAgent('live', 'current live task', 2),
    ], 'live')

    const loaded = await registry.load(new Set(['live']))
    assert.deepEqual(loaded.agents.map((agent) => agent.sessionID), ['live'])
    assert.equal(loaded.droppedSessionCount, 1)
    await registry.save(loaded.agents, 'live', loaded.staleBySession)
    const raw = await readFile(registry.path, 'utf8')
    assert.doesNotMatch(raw, /deleted/)
  } finally {
    await fixture.cleanup()
  }
})

test('workspace changes while Cuppet is offline revoke persisted file privilege and mark refresh stale', async () => {
  const fixture = await fixtureDir()
  try {
    const path = 'src/auth/token.ts'
    await mkdir(join(fixture.root, 'src/auth'), { recursive: true })
    await writeFile(join(fixture.root, path), 'before\n')
    const agent = fakeAgent('auth', 'fix auth refresh token', 1, path)
    const registry = new Pe3TaskRegistry(fixture.store, fixture.root)
    await registry.save([agent], 'auth')

    await writeFile(join(fixture.root, path), 'after-with-different-size\n')
    const loaded = await registry.load(new Set(['auth']))
    const restored = loaded.agents[0]!

    assert.equal(restored.activePaths.includes(path), false)
    assert.equal(restored.touchedPaths.includes(path), false)
    assert.equal(restored.fingerprint.paths.some((signal) => signal.value === path), false)
    assert.deepEqual(restored.stalePaths, [path])
    assert.deepEqual(loaded.staleBySession.get('auth'), [path])
    assert.equal(restored.cacheEpoch, agent.cacheEpoch + 1)
  } finally {
    await fixture.cleanup()
  }
})

test('registry is bounded, private, redacted, and contains routing metadata only', async () => {
  const fixture = await fixtureDir()
  try {
    const registry = new Pe3TaskRegistry(fixture.store, fixture.root)
    const secretIndex = PE3_MAX_PERSISTED_AGENTS + 8
    const agents = Array.from({ length: PE3_MAX_PERSISTED_AGENTS + 9 }, (_, index) =>
      fakeAgent(
        `s${index}`,
        index === secretIndex ? 'use api_key=sk-supersecretvalue123456789 for auth' : `task ${index}`,
        index,
      ),
    )
    agents[secretIndex]!.terms.push('sk-supersecretvalue123456789')
    await registry.save(agents, agents.at(-1)?.sessionID)

    const raw = await readFile(registry.path, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const info = await stat(registry.path)
    assert.equal((parsed.agents as unknown[]).length, PE3_MAX_PERSISTED_AGENTS)
    assert.equal(info.mode & 0o777, 0o600)
    assert.doesNotMatch(raw, /sk-supersecretvalue123456789/)
    assert.doesNotMatch(raw, /assistantBuffer|messages|transcript|toolOutput/)
    assert.match(raw, /REDACTED/)
  } finally {
    await fixture.cleanup()
  }
})

function adapterHarness(initialID?: string): {
  adapter: TaskSessionAdapter
  resumed: string[]
} {
  let currentID = initialID
  let created = initialID ? 2 : 0
  const resumed: string[] = []
  return {
    resumed,
    adapter: {
      current: () => currentID ? { id: currentID } : undefined,
      create: async () => {
        created += 1
        currentID = `s${created}`
        return { id: currentID }
      },
      resume: async (sessionID) => {
        resumed.push(sessionID)
        currentID = sessionID
        return { id: sessionID }
      },
      evidence: () => ({}),
    },
  }
}

function fakeAgent(sessionID: string, descriptor: string, lastActiveAt: number, path?: string): TaskAgentState {
  const paths = path ? [path] : []
  return {
    id: `task:${sessionID}`,
    sessionID,
    taskDescriptor: descriptor,
    activePaths: [...paths],
    touchedPaths: [...paths],
    recentSymbols: [],
    terms: descriptor.toLowerCase().split(/\s+/).filter(Boolean),
    fingerprint: {
      revision: 1,
      paths: paths.map((value) => ({ value, weight: 1, source: 'touched' as const, updatedAt: lastActiveAt })),
      symbols: [],
      terms: descriptor.toLowerCase().split(/\s+/).filter(Boolean).map((value) => ({
        value,
        weight: 0.32,
        source: 'prompt' as const,
        updatedAt: lastActiveAt,
      })),
    },
    stalePaths: [],
    cacheEpoch: 0,
    workspaceEpoch: 0,
    createdAt: lastActiveAt,
    lastActiveAt,
    turns: 1,
  }
}

async function fixtureDir(): Promise<{
  root: string
  store: string
  cleanup: () => Promise<void>
}> {
  const base = await mkdtemp(join(tmpdir(), 'cuppet-pe3-persist-'))
  const root = join(base, 'project')
  const store = join(base, 'state', 'projects', 'project-id')
  await mkdir(root, { recursive: true })
  return {
    root,
    store,
    cleanup: () => rm(base, { recursive: true, force: true }),
  }
}
