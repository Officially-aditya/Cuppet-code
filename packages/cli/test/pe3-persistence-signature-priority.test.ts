import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { PE3_MAX_PATH_SIGNATURES, Pe3TaskRegistry, restorePersistedTaskAgents } from '../src/pe3/persistence.js'
import { TaskSessionRouter } from '../src/pe3/session-router.js'
import type { TaskAgentState } from '../src/pe3/task-agents.js'

test('signature cap keeps the active task first, then remaining tasks by recency', async () => {
  const fixture = await fixtureDir()
  try {
    const agents = Array.from({ length: 9 }, (_, index) => makeAgent(`s${index}`, 1000 - index, index))
    const active = agents[8]!
    const allPaths = agents.flatMap((agent) => agent.activePaths)
    await createFiles(fixture.root, allPaths)

    const registry = new Pe3TaskRegistry(fixture.store, fixture.root)
    await registry.save(agents, active.sessionID)
    const firstKeys = await signatureKeys(registry.path)

    const expected = [
      ...active.activePaths,
      ...agents.slice(0, 7).flatMap((agent) => agent.activePaths),
    ]
    assert.equal(firstKeys.length, PE3_MAX_PATH_SIGNATURES)
    assert.deepEqual(firstKeys, expected)
    assert.ok(agents[0]!.activePaths.every((path) => firstKeys.includes(path)), 'newest non-active task must remain signed')
    assert.ok(active.activePaths.every((path) => firstKeys.includes(path)), 'active task must remain signed even when it is oldest')
    assert.ok(agents[7]!.activePaths.every((path) => !firstKeys.includes(path)), 'lowest-priority non-active task should lose the cap race')

    await registry.save(agents, active.sessionID)
    assert.deepEqual(await signatureKeys(registry.path), firstKeys, 'signature ordering must be deterministic')
  } finally {
    await fixture.cleanup()
  }
})

test('a retained active-task signature still drives offline stale invalidation and restored refresh state', async () => {
  const fixture = await fixtureDir()
  try {
    const agents = Array.from({ length: 9 }, (_, index) => makeAgent(`s${index}`, 1000 - index, index))
    const active = agents[8]!
    const allPaths = agents.flatMap((agent) => agent.activePaths)
    await createFiles(fixture.root, allPaths)

    const registry = new Pe3TaskRegistry(fixture.store, fixture.root)
    await registry.save(agents, active.sessionID)
    const changedPath = active.activePaths[0]!
    await writeFile(join(fixture.root, changedPath), 'changed-content-with-a-different-size\n')

    const loaded = await registry.load(new Set(agents.map((agent) => agent.sessionID)))
    const loadedActive = loaded.agents.find((agent) => agent.sessionID === active.sessionID)
    assert.ok(loadedActive)
    assert.ok(loadedActive.stalePaths.includes(changedPath))
    assert.equal(loadedActive.activePaths.includes(changedPath), false)
    assert.equal(loadedActive.fingerprint.paths.some((signal) => signal.value === changedPath), false)
    assert.equal(loadedActive.cacheEpoch, active.cacheEpoch + 1)

    const router = new TaskSessionRouter(undefined, { semantic: false })
    restorePersistedTaskAgents(router, loaded, active.sessionID)
    assert.equal(router.active?.sessionID, active.sessionID)
    assert.ok(router.active?.stalePaths.includes(changedPath))
  } finally {
    await fixture.cleanup()
  }
})

function makeAgent(sessionID: string, lastActiveAt: number, group: number): TaskAgentState {
  const activePaths = Array.from({ length: 16 }, (_, index) => `src/g${group}/file-${index}.ts`)
  return {
    id: `task:${sessionID}`,
    sessionID,
    taskDescriptor: `task ${group}`,
    activePaths,
    touchedPaths: [],
    recentSymbols: [],
    terms: [`group-${group}`],
    fingerprint: {
      revision: 4,
      paths: activePaths.map((value, index) => ({
        value,
        weight: 0.7,
        source: 'active' as const,
        updatedAt: lastActiveAt - index,
      })),
      symbols: [],
      terms: [{ value: `group-${group}`, weight: 0.5, source: 'prompt', updatedAt: lastActiveAt }],
    },
    stalePaths: [],
    cacheEpoch: 2,
    workspaceEpoch: 3,
    createdAt: lastActiveAt - 100,
    lastActiveAt,
    turns: 5,
  }
}

async function createFiles(root: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `content for ${path}\n`)
  }
}

async function signatureKeys(registryPath: string): Promise<string[]> {
  const stored = JSON.parse(await readFile(registryPath, 'utf8')) as { fileSignatures: Record<string, unknown> }
  return Object.keys(stored.fileSignatures)
}

async function fixtureDir() {
  const base = await mkdtemp(join(tmpdir(), 'cuppet-pe3-signature-priority-'))
  const root = join(base, 'project')
  const store = join(base, 'state')
  await mkdir(root, { recursive: true })
  return { root, store, cleanup: () => rm(base, { recursive: true, force: true }) }
}
