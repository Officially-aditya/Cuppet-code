import { randomBytes } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { OpenCodeGateway } from '../packages/cli/src/opencode/gateway.js'
import { startOpenCodeServer } from '../packages/cli/src/opencode/server.js'
import { RedactedLogger, redact } from '../packages/cli/src/runtime/logger.js'
import { createRuntimePaths } from '../packages/cli/src/runtime/paths.js'
import { startTstDaemon } from '../packages/cli/src/tst/supervisor.js'

type Arm = 'native' | 'stm_only'
type AnyRecord = Record<string, unknown>

const SOURCE_SESSION = 'ses_051a6dccfffeLLX0zbl9Scp5WS'
const PROJECT = '/Users/addy/Downloads/TST'
const OPENCODE = '/private/tmp/cuppet-opencode-built-20260801/opencode'
const TST = '/Users/addy/Downloads/cuppet/target/debug/tst-daemon'
const PLUGIN = '/Users/addy/Downloads/cuppet/packages/opencode-plugin/dist/index.js'
const PERSISTENT_ROOT = join(homedir(), '.cuppet', 'v2', 'opencode')

async function main(): Promise<void> {
  const source = await inspectSource()
  const results = []
  for (const arm of ['native', 'stm_only'] as const) {
    results.push(await runArm(arm, source))
  }

  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const output = join(process.cwd(), 'benchmarks', 'results', `session-retention-${SOURCE_SESSION}-${stamp}.json`)
  await writeAtomic(output, `${JSON.stringify({
    sourceSession: SOURCE_SESSION,
    project: PROJECT,
    source,
    arms: results,
  }, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify({
    sourceSession: SOURCE_SESSION,
    project: PROJECT,
    sourceMessages: source.messageCount,
    sourceUserTurns: source.userTurns,
    arms: results.map((result) => ({
      arm: result.arm,
      forkedSession: result.forkedSession,
      beforeMessages: result.beforeMessages,
      afterMessages: result.afterMessages,
      durationMs: result.durationMs,
      refreshes: result.refreshes,
      retainedRecords: result.retention.recordCount,
      retainedPaths: result.retention.pathCount,
      groundedRecordRate: result.retention.groundedRecordRate,
      ltmExcluded: result.retention.ltmExcluded,
      graphExcluded: result.retention.graphExcluded,
      compactionTokens: result.compactionTokens,
      syntheticTextSnippets: result.syntheticTextSnippets,
    })),
    output,
    artifacts: results.map((result) => result.artifactRoot),
  }, null, 2)}\n`)
}

async function inspectSource(): Promise<{
  messageCount: number
  userTurns: number
  model?: unknown
  userPrompts: string[]
  sourceText: string
  lastMessageID?: string
}> {
  const root = await mkdtemp(join('/private/tmp', 'cuppet-session-source-'))
  const paths = await createRuntimePaths(PROJECT, root)
  await seedProviderState(paths)
  const logger = new RedactedLogger(paths.logs)
  const opencode = await startOpenCodeServer({
    binary: OPENCODE,
    paths,
    logger,
    plugin: PLUGIN,
  })
  try {
    const gateway = new OpenCodeGateway(opencode.client, PROJECT)
    const session = await gateway.getSession(SOURCE_SESSION)
    const messages = await gateway.messages(SOURCE_SESSION)
    const userPrompts = messages
      .filter((message) => asRecord(asRecord(message).info).role === 'user')
      .map((message) => redact(compactText(messageText(message), 1_200)))
      .filter(Boolean)
    const lastMessageID = messages
      .map((message) => stringValue(asRecord(asRecord(message).info).id))
      .filter(Boolean)
      .at(-1)
    return {
      messageCount: messages.length,
      userTurns: userPrompts.length,
      ...(session.model ? { model: session.model } : {}),
      userPrompts,
      sourceText: messages.map(messageText).join('\n'),
      ...(lastMessageID ? { lastMessageID } : {}),
    }
  } finally {
    await opencode.close()
  }
}

async function runArm(
  arm: Arm,
  source: Awaited<ReturnType<typeof inspectSource>>,
): Promise<AnyRecord & {
  arm: Arm
  forkedSession: string
  beforeMessages: number
  afterMessages: number
  durationMs: number
  refreshes: number
  compactionTokens: number
  syntheticTextSnippets: string[]
  artifactRoot: string
  retention: AnyRecord
}> {
  const artifactRoot = await mkdtemp(join('/private/tmp', `cuppet-session-${arm}-`))
  const paths = await createRuntimePaths(PROJECT, artifactRoot)
  await seedProviderState(paths)
  const logger = new RedactedLogger(paths.logs)
  const previousFlag = process.env.CUPPET_STM_ONLY_COMPACTION
  if (arm === 'stm_only') process.env.CUPPET_STM_ONLY_COMPACTION = '1'
  else delete process.env.CUPPET_STM_ONLY_COMPACTION

  let tst: Awaited<ReturnType<typeof startTstDaemon>> | undefined
  let opencode: Awaited<ReturnType<typeof startOpenCodeServer>> | undefined
  const refreshes: AnyRecord[] = []
  const started = performance.now()
  try {
    tst = await startTstDaemon(TST, paths, logger)
    tst.client.onNotification((notification) => {
      if (notification.method === 'stm.refreshed') refreshes.push(asRecord(notification.params))
    })
    opencode = await startOpenCodeServer({
      binary: OPENCODE,
      paths,
      logger,
      plugin: PLUGIN,
      tst: { socket: tst.socket, token: tst.token },
    })
    const gateway = new OpenCodeGateway(opencode.client, PROJECT)
    // The v2 catalog exposes compaction/context, while fork remains on the
    // stable session surface in the pinned OpenCode SDK.
    const forkResponse = await opencode.client.session.fork({
      sessionID: SOURCE_SESSION,
      directory: PROJECT,
      ...(source.lastMessageID ? { messageID: source.lastMessageID } : {}),
    }, { throwOnError: true }) as AnyRecord
    const forked = asRecord(forkResponse.data)
    const forkedSession = stringValue(forked.id)
    if (!forkedSession) throw new Error(`OpenCode did not return a forked session for ${arm}`)
    const sourceModel = normalizeModel(source.model)
    if (!sourceModel) throw new Error('Source session has no selected model')
    // OpenCode 1.18.4 copies the forked messages but leaves the child model
    // empty. Re-attach the source selection before asking the native compact
    // endpoint to run; this changes only the disposable child session.
    await opencode.client.v2.session.switchModel({
      sessionID: forkedSession,
      model: {
        id: sourceModel.modelID,
        providerID: sourceModel.providerID,
        ...(sourceModel.variant ? { variant: sourceModel.variant } : {}),
      },
    }, { throwOnError: true })
    const beforeMessages = (await gateway.messages(forkedSession)).length
    const before = await gateway.getSession(forkedSession)
    await gateway.compact(forkedSession)
    await gateway.wait(forkedSession)
    const afterMessagesList = await gateway.messages(forkedSession)
    const after = await gateway.getSession(forkedSession)
    const prepared = await tst.client.call<AnyRecord>('context.prepare', {
      session_id: forkedSession,
      query: source.userPrompts.slice(-3).join('\n'),
      mode: 'stm_only',
      observations: [],
    })
    const refreshResult = refreshes.at(-1)
      ? asRecord(asRecord(refreshes.at(-1)).result)
      : undefined
    const records = arrayValue(refreshResult?.records ?? refreshResult?.retained ?? prepared.stm)
    const pathsValue = stringArray(refreshResult?.paths ?? refreshResult?.retained_paths ?? prepared.paths)
    const activeContext = await opencode.client.v2.session.context({ sessionID: forkedSession }, { throwOnError: true }) as AnyRecord
    const activeContextData = arrayValue(activeContext.data)
    const syntheticTextSnippets = afterMessagesList
      .flatMap(messageParts)
      .filter((part) => part.synthetic === true && typeof part.text === 'string')
      .map((part) => redact(compactText(String(part.text), 900)))
      .filter(Boolean)
      .slice(-4)
    const retention = retentionCheck(records, pathsValue, prepared, source.sourceText)
    return {
      arm,
      forkedSession,
      beforeMessages,
      afterMessages: afterMessagesList.length,
      durationMs: Math.round(performance.now() - started),
      refreshes: refreshes.length,
      compactionTokens: Math.max(0, after.tokens.input - before.tokens.input),
      syntheticTextSnippets,
      artifactRoot,
      retention: {
        ...retention,
        refreshEvents: refreshes.map(summarizeRefreshEvent),
        activeContextMessages: activeContextData.length,
        activeContextText: activeContextData
          .map(messageText)
          .filter(Boolean)
          .map((text) => redact(compactText(text, 1_200)))
          .slice(-4),
      },
      tokensBefore: before.tokens,
      tokensAfter: after.tokens,
      cost: after.cost,
      userPrompts: source.userPrompts,
    }
  } finally {
    await opencode?.close().catch(() => undefined)
    await tst?.close().catch(() => undefined)
    if (previousFlag === undefined) delete process.env.CUPPET_STM_ONLY_COMPACTION
    else process.env.CUPPET_STM_ONLY_COMPACTION = previousFlag
  }
}

function retentionCheck(records: unknown[], paths: string[], prepared: AnyRecord, sourceText: string): AnyRecord {
  const grounded = records.filter((record) => {
    const value = asRecord(record)
    const text = `${stringValue(value.key)} ${stringValue(value.value)}`.toLowerCase()
    const tokens = text.split(/[^a-z0-9_./-]+/).filter((token) => token.length >= 3)
    return tokens.filter((token) => sourceText.toLowerCase().includes(token)).length >= Math.min(3, tokens.length)
  }).length
  return {
    recordCount: records.length,
    pathCount: paths.length,
    paths: paths.slice(0, 64),
    records: records.slice(0, 32).map((record) => {
      const value = asRecord(record)
      return {
        key: stringValue(value.key),
        value: redact(compactText(stringValue(value.value), 700)),
        pinned: value.pinned === true,
        provenance: value.provenance,
        scope: value.scope,
      }
    }),
    groundedRecordRate: records.length === 0 ? 0 : grounded / records.length,
    ltmExcluded: Array.isArray(prepared.ltm) && prepared.ltm.length === 0,
    graphExcluded: Array.isArray(prepared.graph) && prepared.graph.length === 0,
    preparedStmCount: Array.isArray(prepared.stm) ? prepared.stm.length : 0,
  }
}

function summarizeRefreshEvent(event: AnyRecord): AnyRecord {
  const result = asRecord(event.result)
  const eviction = asRecord(result.eviction)
  return {
    retained: numberValue(eviction.retained),
    candidateCount: numberValue(eviction.candidate_count),
    evicted: numberValue(eviction.evicted),
    paths: stringArray(result.paths).slice(0, 64),
  }
}

async function seedProviderState(paths: Awaited<ReturnType<typeof createRuntimePaths>>): Promise<void> {
  const files = [
    { source: join(PERSISTENT_ROOT, 'data', 'opencode', 'auth.json'), target: join(paths.opencode.data, 'opencode', 'auth.json') },
    { source: join(PERSISTENT_ROOT, 'data', 'opencode', 'opencode.db'), target: join(paths.opencode.data, 'opencode', 'opencode.db') },
    { source: join(PERSISTENT_ROOT, 'data', 'opencode', 'opencode.db-wal'), target: join(paths.opencode.data, 'opencode', 'opencode.db-wal') },
    { source: join(PERSISTENT_ROOT, 'data', 'opencode', 'opencode.db-shm'), target: join(paths.opencode.data, 'opencode', 'opencode.db-shm') },
    { source: join(PERSISTENT_ROOT, 'cache', 'opencode', 'models.json'), target: join(paths.opencode.cache, 'opencode', 'models.json') },
  ]
  for (const file of files) {
    try {
      await mkdir(dirname(file.target), { recursive: true, mode: 0o700 })
      await cp(file.source, file.target, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

function messageText(value: unknown): string {
  return messageParts(value)
    .filter((part) => typeof part.text === 'string')
    .map((part) => String(part.text))
    .join('\n')
}

function messageParts(value: unknown): AnyRecord[] {
  const message = asRecord(value)
  return Array.isArray(message.parts) ? message.parts.map(asRecord) : []
}

function asRecord(value: unknown): AnyRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : {}
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeModel(value: unknown): { providerID: string; modelID: string; variant?: string } | undefined {
  const model = asRecord(value)
  const providerID = stringValue(model.providerID)
  const modelID = stringValue(model.modelID) || stringValue(model.id)
  if (!providerID || !modelID) return undefined
  const variant = stringValue(model.variant)
  return { providerID, modelID, ...(variant ? { variant } : {}) }
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function compactText(value: string, limit: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit)
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}

main().catch((error) => {
  process.stderr.write(`Existing-session retention test failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
