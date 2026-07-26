import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveRuntimeAssets } from '../packages/cli/src/runtime/assets.js'
import { RedactedLogger } from '../packages/cli/src/runtime/logger.js'
import { createRuntimePaths } from '../packages/cli/src/runtime/paths.js'
import { startTstDaemon, type TstRuntime } from '../packages/cli/src/tst/supervisor.js'

const fixtureFiles = 4_096
const stmCapacity = 256
const completedTurns = 250
const expectedDecayBeta = 0.98

type GraphStatus = {
  files?: number
  nodes?: number
  progress?: { complete?: boolean; indexed?: number; discovered?: number }
}

type Status = { graph?: GraphStatus; stm_entries?: number }
type GraphSearch = { nodes?: Array<{ node?: { name?: string; path?: string } }> }
type MemoryRecord = { key: string; score: number; pinned: boolean }
type MemoryQuery = { stm?: MemoryRecord[] }

async function main(): Promise<void> {
  const project = resolve(process.cwd())
  const root = await mkdtemp(join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'cuppet-native-tst-'))
  const fixture = join(root, 'fixture')
  let cold: TstRuntime | undefined
  let warm: TstRuntime | undefined

  try {
    await createFixture(fixture)
    const paths = await createRuntimePaths(fixture, join(root, 'runtime'))
    const assets = await resolveRuntimeAssets()
    if (!assets.tst) throw new Error(`Native TST runtime unavailable: ${assets.diagnostics.join('; ')}`)
    const logger = new RedactedLogger(paths.logs)

    const coldStart = performance.now()
    cold = await startTstDaemon(assets.tst, paths, logger)
    const coldDaemonStartMs = Math.round(performance.now() - coldStart)
    const coldIndexStart = performance.now()
    const coldStatus = await waitForIndex(cold, 'cold')
    const coldIndexMs = Math.round(performance.now() - coldIndexStart)
    const coldSearch = await graphSearch(cold, 'persistentGraphTarget')
    ensureGraphMatch(coldSearch, 'persistentGraphTarget', 'cold index')
    await cold.close()
    cold = undefined

    const snapshot = await stat(join(paths.projectStore, 'graph.msgpack'))
    const warmStart = performance.now()
    warm = await startTstDaemon(assets.tst, paths, logger)
    const warmDaemonStartMs = Math.round(performance.now() - warmStart)
    const warmStatusBeforeProbe = await warm.client.call<Status>('status')
    const warmProbeStart = performance.now()
    const warmSearch = await graphSearch(warm, 'persistentGraphTarget')
    const warmFirstGraphQueryMs = Math.round(performance.now() - warmProbeStart)
    ensureGraphMatch(warmSearch, 'persistentGraphTarget', 'persisted snapshot')
    const warmRevalidationStart = performance.now()
    const warmStatus = await waitForIndex(warm, 'warm revalidation')
    const warmRevalidationMs = Math.round(performance.now() - warmRevalidationStart)

    const decay = await measureDecay(warm)
    const report = {
      schema: 1,
      createdAt: new Date().toISOString(),
      project,
      design: 'Native tst-daemon test on a generated 4,096-file TypeScript fixture. Cold indexing is followed by a daemon restart against the same project store; the first graph search is issued before waiting for background revalidation. STM decay uses a full 256-slot session and measures complete turn.completed RPCs.',
      graphPersistence: {
        fixtureFiles,
        coldDaemonStartMs,
        coldIndexMs,
        coldFiles: coldStatus.files ?? 0,
        snapshotBytes: snapshot.size,
        warmDaemonStartMs,
        warmFirstGraphQueryMs,
        warmSnapshotAvailableBeforeRevalidation: !warmStatusBeforeProbe.graph?.progress?.complete,
        warmRevalidationMs,
        warmFiles: warmStatus.files ?? 0,
      },
      stmDecay: decay,
    }

    const outputDirectory = join(project, 'benchmarks', 'results')
    await mkdir(outputDirectory, { recursive: true })
    const stamp = new Date().toISOString().replaceAll(':', '-')
    const jsonPath = join(outputDirectory, `native-tst-${stamp}.json`)
    const markdownPath = join(outputDirectory, `native-tst-${stamp}.md`)
    await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    await writeFile(markdownPath, `${renderMarkdown(report)}\n`, 'utf8')
    process.stdout.write(`${JSON.stringify(report, null, 2)}\nRaw result: ${jsonPath}\nSummary: ${markdownPath}\n`)
  } finally {
    await cold?.close().catch(() => undefined)
    await warm?.close().catch(() => undefined)
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function createFixture(root: string): Promise<void> {
  const source = join(root, 'src')
  await mkdir(source, { recursive: true })
  const writes: Promise<void>[] = []
  for (let index = 0; index < fixtureFiles; index += 1) {
    const name = `module${index}`
    writes.push(writeFile(
      join(source, `${name}.ts`),
      `export function ${name}(value: number): number { return value + ${index} }\n`,
      'utf8',
    ))
    if (writes.length === 64) {
      await Promise.all(writes.splice(0, writes.length))
    }
  }
  await Promise.all(writes)
  await writeFile(
    join(source, 'persistent-entry.ts'),
    'export function persistentGraphTarget(value: string): string { return value.toUpperCase() }\n',
    'utf8',
  )
}

async function graphSearch(runtime: TstRuntime, pattern: string): Promise<GraphSearch> {
  return runtime.client.call<GraphSearch>('graph.search', { pattern, limit: 8 })
}

function ensureGraphMatch(search: GraphSearch, symbol: string, phase: string): void {
  if (search.nodes?.some((result) => result.node?.name === symbol)) return
  throw new Error(`${phase} did not return ${symbol}`)
}

async function waitForIndex(runtime: TstRuntime, label: string): Promise<GraphStatus> {
  const deadline = Date.now() + 3 * 60_000
  while (Date.now() < deadline) {
    const status = await runtime.client.call<Status>('status')
    const graph = status.graph ?? {}
    if (graph.progress?.complete) return graph
    process.stdout.write(`${label}: indexing ${graph.progress?.indexed ?? 0}/${graph.progress?.discovered ?? '?'}\r`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  throw new Error(`${label} graph indexing timed out`)
}

async function measureDecay(runtime: TstRuntime): Promise<Record<string, number | boolean> & { expectedScore: number; observedScore: number }> {
  const sessionID = 'native-stm-decay'
  await runtime.client.call('memory.observe', {
    session_id: sessionID,
    key: 'decaying retention target',
    value: 'Unpinned memory used to verify decay.',
    kind: 'concept_anchor',
    scope: 'session',
    provenance: 'model_candidate',
  })
  await runtime.client.call('memory.observe', {
    session_id: sessionID,
    key: 'pinned retention target',
    value: 'Pinned memory must not decay.',
    kind: 'concept_anchor',
    scope: 'session',
    provenance: 'model_candidate',
    pinned: true,
  })
  for (let index = 0; index < stmCapacity - 2; index += 1) {
    await runtime.client.call('memory.observe', {
      session_id: sessionID,
      key: `filler memory ${index}`,
      value: `Filler entry ${index}`,
      kind: 'concept_anchor',
      scope: 'session',
      provenance: 'model_candidate',
    })
  }

  const started = performance.now()
  for (let turn = 0; turn < completedTurns; turn += 1) {
    await runtime.client.call('turn.completed', { session_id: sessionID })
  }
  const durationMs = performance.now() - started
  const query = await runtime.client.call<MemoryQuery>('memory.query', {
    session_id: sessionID,
    query: 'decaying retention target',
    limit: 128,
  })
  const decaying = query.stm?.find((record) => record.key === 'decaying retention target')
  const pinned = query.stm?.find((record) => record.key === 'pinned retention target')
  if (!decaying || !pinned) throw new Error('STM query did not return the decay control records')

  const expectedScore = 0.5 * expectedDecayBeta ** completedTurns
  if (Math.abs(decaying.score - expectedScore) > 0.000_01) {
    throw new Error(`unexpected decayed score: expected ${expectedScore}, received ${decaying.score}`)
  }
  if (pinned.score !== 0.5 || !pinned.pinned) {
    throw new Error(`pinned STM record changed score unexpectedly: ${pinned.score}`)
  }
  const status = await runtime.client.call<Status>('status')
  if (status.stm_entries !== stmCapacity) {
    throw new Error(`STM capacity changed during decay: expected ${stmCapacity}, received ${status.stm_entries ?? 'unknown'}`)
  }

  return {
    capacity: stmCapacity,
    completedTurns,
    durationMs: Number(durationMs.toFixed(3)),
    perTurnMs: Number((durationMs / completedTurns).toFixed(4)),
    recordsTouched: stmCapacity * completedTurns,
    recordsPerSecond: Math.round((stmCapacity * completedTurns * 1_000) / durationMs),
    expectedScore,
    observedScore: decaying.score,
    pinnedScoreUnchanged: pinned.score === 0.5,
  }
}

function renderMarkdown(report: {
  createdAt: string
  graphPersistence: Record<string, number | boolean>
  stmDecay: Record<string, number | boolean>
}): string {
  const graph = report.graphPersistence
  const stm = report.stmDecay
  return [
    '# Native graph persistence and STM decay benchmark',
    '',
    `- Created: ${report.createdAt}`,
    '- Graph result is available immediately after daemon restart from the same project store; background revalidation is measured separately.',
    '- STM timing covers full daemon `turn.completed` RPCs at the fixed 256-entry capacity, including promotion eligibility checks.',
    '',
    '## Graph persistence',
    '',
    `- Cold index: ${graph.coldIndexMs} ms for ${graph.fixtureFiles} files (${graph.coldFiles} indexed).`,
    `- Snapshot: ${graph.snapshotBytes} bytes.`,
    `- Warm daemon start: ${graph.warmDaemonStartMs} ms; first restored-graph query: ${graph.warmFirstGraphQueryMs} ms.`,
    `- Restored graph was available before background revalidation completed: ${graph.warmSnapshotAvailableBeforeRevalidation ? 'yes' : 'no'}.`,
    `- Background revalidation: ${graph.warmRevalidationMs} ms (${graph.warmFiles} indexed files).`,
    '',
    '## STM decay',
    '',
    `- ${stm.completedTurns} completed turns across ${stm.capacity} entries: ${stm.durationMs} ms (${stm.perTurnMs} ms/turn).`,
    `- Effective full-path throughput: ${stm.recordsPerSecond} records/s across ${stm.recordsTouched} record updates.`,
    `- Unpinned score: ${stm.observedScore} (expected ${stm.expectedScore}); pinned score unchanged: ${stm.pinnedScoreUnchanged ? 'yes' : 'no'}.`,
    '',
    'Decay is a bounded in-place retention/eviction signal. It does not remove entries or reduce retrieval-context size by itself, so this is an operational efficiency check rather than a model-token reduction claim.',
  ].join('\n')
}

main().catch((error) => {
  process.stderr.write(`Native TST benchmark failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
