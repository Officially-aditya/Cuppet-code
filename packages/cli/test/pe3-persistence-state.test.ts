import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Pe3TaskRegistry, restorePersistedTaskAgents } from '../src/pe3/persistence.js'
import { SemanticTaskRouter, type TaskEmbeddingProvider } from '../src/pe3/semantic-router.js'
import { TaskSessionRouter, type TaskSessionAdapter } from '../src/pe3/session-router.js'
import type { TaskAgentState } from '../src/pe3/task-agents.js'

test('save-load-restore preserves validated rich task-agent routing state exactly', async () => {
  const fixture = await fixtureDir()
  try {
    const state = richAgent('auth', 1700000000100)
    const registry = new Pe3TaskRegistry(fixture.store, fixture.root)
    await registry.save([state], 'auth')
    const loaded = await registry.load(new Set(['auth']))

    const router = new TaskSessionRouter(undefined, { semantic: false })
    restorePersistedTaskAgents(router, loaded, 'auth')

    assert.deepEqual(router.active, loaded.agents[0])
    assert.deepEqual(router.agents(), loaded.agents)
    assert.equal(router.active?.lastActiveAt, 1700000000100)
    assert.equal(router.active?.createdAt, 1700000000000)
    assert.equal(router.active?.turns, 17)
    assert.equal(router.active?.cacheEpoch, 5)
    assert.equal(router.active?.workspaceEpoch, 9)
    assert.equal(router.active?.fingerprint.revision, 23)
    assert.deepEqual(router.active?.stalePaths, ['src/auth/stale.ts'])
    assert.deepEqual(router.active?.fingerprint.paths[0], {
      value: 'src/auth/token.ts',
      weight: 0.73,
      source: 'touched',
      updatedAt: 1699999999000,
    })
    assert.deepEqual(router.active?.fingerprint.symbols[0], {
      value: 'refreshtoken',
      weight: 0.61,
      source: 'symbol',
      updatedAt: 1699999999100,
    })
  } finally {
    await fixture.cleanup()
  }
})

test('corrected strongest fingerprint provenance survives save-load-restore', async () => {
  const fixture = await fixtureDir()
  try {
    const path = 'src/auth/token.ts'
    await mkdir(join(fixture.root, 'src/auth'), { recursive: true })
    await writeFile(join(fixture.root, path), 'current\n')

    const source = new TaskSessionRouter(undefined, { semantic: false })
    source.bindSession('auth', {}, `inspect ${path}`)
    assert.equal(source.active?.fingerprint.paths.find((signal) => signal.value === path)?.source, 'prompt')
    source.noteSessionObservedPaths('auth', [path])
    assert.equal(source.active?.fingerprint.paths.find((signal) => signal.value === path)?.source, 'active')
    source.noteSessionWorkspaceMutation('auth', [path])
    assert.equal(source.active?.fingerprint.paths.find((signal) => signal.value === path)?.source, 'touched')

    const registry = new Pe3TaskRegistry(fixture.store, fixture.root)
    await registry.save(source.agents(), 'auth')
    const loaded = await registry.load(new Set(['auth']))
    const restored = new TaskSessionRouter(undefined, { semantic: false })
    restorePersistedTaskAgents(restored, loaded, 'auth')

    assert.equal(restored.active?.fingerprint.paths.find((signal) => signal.value === path)?.source, 'touched')
  } finally {
    await fixture.cleanup()
  }
})

test('offline invalidation survives hydration without replaying the invalidated path', async () => {
  const fixture = await fixtureDir()
  try {
    const path = 'src/auth/token.ts'
    await mkdir(join(fixture.root, 'src/auth'), { recursive: true })
    await writeFile(join(fixture.root, path), 'before\n')
    const state = richAgent('auth', 1700000000100)
    const registry = new Pe3TaskRegistry(fixture.store, fixture.root)
    await registry.save([state], 'auth')

    await writeFile(join(fixture.root, path), 'after-different-size\n')
    const loaded = await registry.load(new Set(['auth']))
    const router = new TaskSessionRouter(undefined, { semantic: false })
    restorePersistedTaskAgents(router, loaded, 'auth')

    const restored = router.active!
    assert.equal(restored.activePaths.includes(path), false)
    assert.equal(restored.touchedPaths.includes(path), false)
    assert.equal(restored.fingerprint.paths.some((signal) => signal.value === path), false)
    assert.ok(restored.stalePaths.includes(path))
    assert.equal(restored.cacheEpoch, state.cacheEpoch + 1)
    assert.equal(restored.workspaceEpoch, state.workspaceEpoch + 1)
    assert.equal(restored.fingerprint.revision, state.fingerprint.revision + 1)
  } finally {
    await fixture.cleanup()
  }
})

test('restored fingerprint evidence can drive dormant semantic reactivation after restart', async () => {
  const fixture = await fixtureDir()
  try {
    const auth = richAgent('auth', 10)
    auth.taskDescriptor = 'maintenance work'
    auth.terms = ['maintenance']
    auth.fingerprint.terms = [{
      value: 'credential-renewal',
      weight: 0.91,
      source: 'prompt',
      updatedAt: 9,
    }]
    const report = richAgent('report', 20)
    report.taskDescriptor = 'report generation'
    report.terms = ['report', 'generation']
    report.activePaths = ['src/report/export.ts']
    report.touchedPaths = ['src/report/export.ts']
    report.fingerprint.paths = [{
      value: 'src/report/export.ts',
      weight: 1,
      source: 'touched',
      updatedAt: 19,
    }]
    report.fingerprint.terms = [{ value: 'report', weight: 0.8, source: 'prompt', updatedAt: 19 }]

    const registry = new Pe3TaskRegistry(fixture.store, fixture.root)
    await registry.save([auth, report], 'report')
    const loaded = await registry.load(new Set(['auth', 'report']))

    const provider: TaskEmbeddingProvider = {
      modelID: 'restored-fingerprint-test',
      embed: async (text) => text.toLowerCase().includes('credential')
        ? new Float32Array([1, 0, 0])
        : new Float32Array([0, 1, 0]),
    }
    const router = new TaskSessionRouter(undefined, { semantic: new SemanticTaskRouter(provider) })
    restorePersistedTaskAgents(router, loaded, 'report')
    const harness = adapterHarness('report')

    const returned = await router.prepare('go back to credential renewal', harness.adapter)

    assert.equal(returned.action, 'reactivate')
    assert.equal(returned.sessionID, 'auth')
    assert.deepEqual(harness.resumed, ['auth'])
    assert.equal(router.stats().semanticReactivated, 1)
  } finally {
    await fixture.cleanup()
  }
})

function richAgent(sessionID: string, lastActiveAt: number): TaskAgentState {
  return {
    id: `task:${sessionID}`,
    sessionID,
    taskDescriptor: 'auth maintenance',
    activePaths: ['src/auth/token.ts'],
    touchedPaths: ['src/auth/token.ts'],
    recentSymbols: ['refreshtoken'],
    terms: ['auth', 'maintenance'],
    fingerprint: {
      revision: 23,
      paths: [{ value: 'src/auth/token.ts', weight: 0.73, source: 'touched', updatedAt: 1699999999000 }],
      symbols: [{ value: 'refreshtoken', weight: 0.61, source: 'symbol', updatedAt: 1699999999100 }],
      terms: [{ value: 'renewal', weight: 0.47, source: 'prompt', updatedAt: 1699999999200 }],
    },
    stalePaths: ['src/auth/stale.ts'],
    cacheEpoch: 5,
    workspaceEpoch: 9,
    createdAt: 1700000000000,
    lastActiveAt,
    turns: 17,
  }
}

function adapterHarness(initialID: string): { adapter: TaskSessionAdapter; resumed: string[] } {
  let currentID = initialID
  const resumed: string[] = []
  return {
    resumed,
    adapter: {
      current: () => ({ id: currentID }),
      create: async () => {
        currentID = 'unexpected-new-session'
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

async function fixtureDir() {
  const base = await mkdtemp(join(tmpdir(), 'cuppet-pe3-full-state-'))
  const root = join(base, 'project')
  const store = join(base, 'state')
  await mkdir(root, { recursive: true })
  return { root, store, cleanup: () => rm(base, { recursive: true, force: true }) }
}
