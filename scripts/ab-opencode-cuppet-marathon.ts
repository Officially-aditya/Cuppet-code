// Marathon A/B benchmark: one persistent session per arm builds a complete
// JSON database engine across 10 sequential heavyweight stages. Every stage's
// verifier also re-runs all earlier stages, so regressions accumulate.
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createOpencodeClient } from '@opencode-ai/sdk/v2'
import { OPENCODE_VERSION } from '../packages/cli/src/constants.js'
import { OpenCodeGateway } from '../packages/cli/src/opencode/gateway.js'
import { DEFAULT_CUPPET_INSTRUCTION, startOpenCodeServer } from '../packages/cli/src/opencode/server.js'
import { RedactedLogger } from '../packages/cli/src/runtime/logger.js'
import { resolveRuntimeAssets } from '../packages/cli/src/runtime/assets.js'
import { createRuntimePaths } from '../packages/cli/src/runtime/paths.js'
import { startTstDaemon, type TstRuntime } from '../packages/cli/src/tst/supervisor.js'
import type { AgentEvent, ModelRef, TokenUsage } from '../packages/cli/src/types.js'

type Arm = 'opencode' | 'cuppet'
type CommandResult = { passed: boolean; code: number | string; stdout: string; stderr: string; durationMs: number }
type UsageStats = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number; totalModel: number; totalWithCache: number }
type UsageStep = UsageStats & { gapSeconds?: number }
type StageUsage = UsageStats & { eventCount: number; cost: number; steps?: UsageStep[] }

type Stage = {
  slug: string
  title: string
  prompt: string
  verifier: (workspace: string) => string
}

type Check = { passed: boolean; detail: string }
type StageEvaluation = { success: boolean; passedChecks: number; totalChecks: number; checks: Record<string, Check> }

type StageResult = {
  index: number
  slug: string
  success: boolean
  attempts: number
  firstAttemptSuccess: boolean
  repaired: boolean
  regressions: string[]
  agentDurationMs: number
  usage: StageUsage
  toolCalls: number
  compactions: number
  evaluation: StageEvaluation
  error?: string
}

const execFile = promisify(execFileCallback)
const project = resolve(process.cwd())
const resultsDirectory = join(project, 'benchmarks', 'results')
const keepWorkspaces = process.env.CUPPET_MARATHON_KEEP_WORKSPACES !== '0'

function parseRequestedModel(): ModelRef | undefined {
  return parseRequestedModelFrom(process.env.CUPPET_AB_MODEL, process.env.CUPPET_AB_VARIANT)
}

function parseRequestedModelFrom(model?: string, variant?: string): ModelRef | undefined {
  const requested = model?.trim()
  if (!requested) return undefined
  const slash = requested.indexOf('/')
  if (slash <= 0 || slash === requested.length - 1) throw new Error('model must be provider/model')
  return { providerID: requested.slice(0, slash), modelID: requested.slice(slash + 1), ...(variant?.trim() ? { variant: variant.trim() } : {}) }
}

const model: ModelRef = parseRequestedModel() ?? { providerID: 'openai', modelID: 'gpt-5.6-luna', variant: 'low' }
const timeoutMs = 25 * 60_000

function verifierSource(workspace: string, body: string): string {
  return `
import assert from 'node:assert/strict'
${body.replaceAll('__WS__', JSON.stringify(workspace))}
console.log('VERIFIER-OK')
`
}

const fixtureEntries: Array<[string, string]> = [
  ['package.json', `{\n  "name": "minidb-marathon",\n  "private": true,\n  "type": "module"\n}\n`],
  ['SPEC.md', `# MiniDB — build a small JSON database engine, stage by stage.

The final system is an importable engine plus a CLI front-end with:
collections of JSON documents (auto string ids), JSON-file persistence,
a query API (filters, sort, projection, limit), unique and non-unique
indexes, transactions with rollback, a line-based REPL command surface,
aggregation pipelines, optional schema validation, durable reload with
index rebuilds, pluggable memory/file backends, and atomic batch apply.

Requirements are delivered one stage at a time. Earlier behavior must
never break: every stage is re-verified against the full history.
`],
]

const stages: Stage[] = [
  {
    slug: 'core-store',
    title: 'Core storage with persistence',
    prompt: `Create src/db.ts implementing MiniDB. Requirements:
1) export class MiniDB with constructor(options?: { file?: string }). If file is set and exists, load all data from it at construction (JSON).
2) db.createCollection(name): void — throws if the name already exists or is empty.
3) db.collection(name): Collection | null.
4) db.dropCollection(name): boolean.
5) A Collection stores plain JSON objects and supports: insert(doc) -> string id (set an auto-generated unique "_id" string on the stored copy AND return it), get(id) -> doc | undefined (return a deep clone), all() -> array of deep-cloned docs in insertion order, delete(id) -> boolean, count() -> number.
6) db.save(): void — when constructed with a file option, persist everything to that path as JSON so a NEW MiniDB({file}) instance sees identical data (ids preserved). Without a file option save() must be a harmless no-op.
7) Deep-clone guarantee: mutating a returned doc must never affect stored data.
Keep src/db.ts self-contained TypeScript (no imports beyond node builtins). Then inspect your work before replying.`,
    verifier: (ws) => verifierSource(ws, `
const { MiniDB } = await import(__WS__ + '/src/db.ts')
const fs = await import('node:fs/promises')
const os = await import('node:os')
const path = await import('node:path')
const file = path.join(os.tmpdir(), 'minidb-core-' + Date.now() + '.json')
const db = new MiniDB()
db.createCollection('users')
assert.throws(() => db.createCollection('users'))
assert.equal(db.collection('nope'), null)
const col = db.collection('users')
const idA = col.insert({ name: 'a', age: 30 })
const idB = col.insert({ name: 'b', age: 40 })
assert.ok(idA && idB && idA !== idB)
assert.equal(col.count(), 2)
const got = col.get(idA)
got.name = 'mutated'
assert.equal(col.get(idA).name, 'a', 'deep clone guarantee')
col.all()[0].name = 'mutated2'
assert.equal(col.get(idA).name, 'a')
assert.equal(col.delete(idB), true)
assert.equal(col.delete(idB), false)
assert.equal(col.count(), 1)
const dbFile = new MiniDB({ file })
dbFile.createCollection('users')
dbFile.collection('users').insert({ name: 'a', age: 30 })
dbFile.save()
const db3 = new MiniDB({ file })
assert.deepEqual(db3.collection('users').all(), [{ _id: 'u1', name: 'a', age: 30 }])
await fs.rm(file, { force: true })
`),
  },
  {
    slug: 'query-api',
    title: 'Query API: filters, sort, projection, limit',
    prompt: `Extend Collection in src/db.ts with find(options?). Requirements:
1) find({ filter?, sort?, projection?, limit? }) returns an array of deep-cloned docs.
2) filter is an object mapping field -> matcher. A plain value means equality. Supported operators as keys: $ne, $gt, $gte, $lt, $lte, $in (array membership of the field value). Multiple fields AND together; multiple operators on one field AND together. Docs missing a compared field never match comparison operators.
3) sort: { [field]: 'asc' | 'desc' } — stable sort; missing fields sort last in asc.
4) projection: { [field]: true } — include ONLY those fields plus "_id".
5) limit: positive integer applied after sorting.
Do not break any existing behavior. Inspect your work before replying.`,
    verifier: (ws) => verifierSource(ws, `
const { MiniDB } = await import(__WS__ + '/src/db.ts')
const db = new MiniDB()
const col = db.createCollection('t') ?? (() => { throw new Error('createCollection must return the collection') })()
const ids = [
  col.insert({ name: 'ann', age: 30, city: 'nyc' }),
  col.insert({ name: 'bob', age: 40, city: 'sf' }),
  col.insert({ name: 'cat', age: 35 }),
  col.insert({ name: 'dan', age: 40, city: 'nyc' }),
]
assert.deepEqual(col.find({ filter: { city: 'nyc' } }).map(d => d.name), ['ann', 'dan'])
assert.deepEqual(col.find({ filter: { age: { $gte: 35 } } }).map(d => d.name).sort(), ['bob', 'cat', 'dan'])
assert.deepEqual(col.find({ filter: { age: { $in: [30, 35] }, city: { $ne: undefined } } }).map(d => d.name), ['ann'])
assert.deepEqual(col.find({ filter: { age: { $lt: 40, $gt: 30 } } }).map(d => d.name), ['cat'])
assert.deepEqual(col.find({ sort: { age: 'desc' }, limit: 2 }).map(d => d.age), [40, 40])
const proj = col.find({ filter: { name: 'ann' }, projection: { name: true } })
assert.deepEqual(proj[0], { _id: ids[0], name: 'ann' })
assert.deepEqual(col.find({ filter: { name: 'nobody' } }), [])
`),
  },
  {
    slug: 'indexes',
    title: 'Unique and non-unique indexes',
    prompt: `Add indexing to Collection in src/db.ts:
1) createIndex(field, options?: { unique?: boolean }): void — building an index on existing docs must throw immediately if unique is true and duplicates exist.
2) With a unique index, insert or update that would duplicate an existing indexed value must throw (and must NOT mutate the collection).
3) Non-unique indexes are bookkeeping only but must stay consistent through insert/delete.
4) dropIndex(field): boolean.
5) After delete of a doc, its indexed value becomes available again for unique inserts.
6) Transactions-free requirement: none yet. Keep find() semantics unchanged. Inspect your work before replying.`,
    verifier: (ws) => verifierSource(ws, `
const { MiniDB } = await import(__WS__ + '/src/db.ts')
const db = new MiniDB()
const col = db.createCollection('u')
const a = col.insert({ email: 'dup@x.io' })
col.insert({ email: 'other@x.io' })
const dup = col.insert({ email: 'dup@x.io' })
assert.throws(() => col.createIndex('email', { unique: true }), /duplicate/i)
col.delete(a)
col.delete(dup)
col.createIndex('email', { unique: true })
assert.doesNotThrow(() => col.insert({ email: 'c@x.io' }))
assert.throws(() => col.insert({ email: 'c@x.io' }), /duplicate/i)
assert.equal(col.count(), 2, 'failed unique insert must not store anything')
col.createIndex('tag')
assert.doesNotThrow(() => { col.insert({ tag: 'x' }); col.insert({ tag: 'x' }) }, 'non-unique allows repeats')
const cid = col.find({ filter: { email: 'c@x.io' } })[0]._id
assert.equal(col.delete(cid), true)
assert.doesNotThrow(() => col.insert({ email: 'c@x.io' }))
assert.equal(col.dropIndex('tag'), true)
assert.equal(col.dropIndex('missing'), false)
`),
  },
  {
    slug: 'transactions',
    title: 'Transactions with rollback',
    prompt: `Add transactions to MiniDB in src/db.ts:
1) db.beginTransaction(): Transaction with commit(): void and rollback(): void.
2) Transaction exposes the same collection handles as the db (tx.collection(name)) whose mutations (insert/delete and later-stage features) are ISOLATED from readers until commit.
3) commit() atomically applies all queued changes; rollback() discards them completely — including index state and id counters.
4) Nested/expired use: calling commit() or rollback() twice must throw; after commit/rollback the transaction's collection methods must throw.
5) Readers using db.collection(...) during an open transaction must NOT see uncommitted changes.
Implement cleanly — later stages will rely on this. Inspect your work before replying.`,
    verifier: (ws) => verifierSource(ws, `
const { MiniDB } = await import(__WS__ + '/src/db.ts')
const db = new MiniDB()
const users = db.createCollection('users')
const keep = users.insert({ name: 'keep' })
const tx = db.beginTransaction()
const tusers = tx.collection('users')
const tempId = tusers.insert({ name: 'temp' })
tusers.delete(keep)
assert.equal(users.get(tempId), undefined, 'uncommitted insert invisible to db readers')
assert.equal(users.count(), 1, 'uncommitted delete invisible')
tx.rollback()
assert.equal(users.count(), 1)
assert.notEqual(users.get(keep), undefined)
assert.throws(() => tx.rollback())
const tx2 = db.beginTransaction()
tx2.collection('users').insert({ name: 'committed' })
tx2.commit()
assert.throws(() => tx2.commit())
assert.equal(users.count(), 2)
`),
  },
  {
    slug: 'cli-repl',
    title: 'CLI REPL command surface',
    prompt: `Create src/cli.ts exposing runReplCommand(db: MiniDB, line: string): string — executes ONE command line and returns a human-readable result string. Commands:
1) ".create <name>" → creates collection, returns "created <name>"
2) ".drop <name>" → returns "dropped <name>" or "not found"
3) '.insert <name> <json>' → inserts parsed JSON object, returns "inserted <id>"
4) '.get <name> <id>' → returns the JSON of the doc or "not found"
5) '.find <name> <jsonFilter?>' → JSON array of matches (filter omitted = all)
6) '.update <name> <id> <json>' → merges fields into the doc, returns "updated <id>" or "not found"
7) '.delete <name> <id>' → returns "deleted <id>" or "not found"
8) ".stats" → returns a string containing each collection name and its document count
9) Unknown or malformed input returns a string starting with "error:" (never throws).
Also make update() on Collection public if it is not already (merge semantics, respects unique indexes). Inspect your work before replying.`,
    verifier: (ws) => verifierSource(ws, `
const { MiniDB } = await import(__WS__ + '/src/db.ts')
const { runReplCommand } = await import(__WS__ + '/src/cli.ts')
const db = new MiniDB()
const out = (line) => runReplCommand(db, line)
assert.match(out('.create people'), /created people/)
assert.match(out('.insert people {"name":"ann","age":30}'), /inserted \\S+/)
const ins = out('.find people')
assert.ok(ins.includes('"ann"'))
const id = JSON.parse(out('.find people'))[0]._id
assert.match(out('.update people ' + id + ' {"age":31}'), /updated/)
assert.equal(JSON.parse(out('.find people {"age":31}')).length, 1)
assert.match(out('.delete people ' + id), /deleted/)
assert.match(out('.get people ' + id), /not found/)
out('.create stuff'); out('.insert stuff {"k":1}')
assert.match(out('.stats'), /people.*1/s)
assert.match(out('.stats'), /stuff.*1/s)
assert.match(out('.bogus'), /^error:/)
assert.match(out('.insert people not-json'), /^error:/)
`),
  },
  {
    slug: 'aggregation',
    title: 'Aggregation pipeline',
    prompt: `Add aggregation to Collection in src/db.ts: aggregate(pipeline) where pipeline is an ordered array of stages:
1) { $match: filter } — same filter semantics as find().
2) { $group: { by: field | (doc) => string, count?: true, sum?: field, avg?: field } } — emits one doc per distinct key: { _id: key, ...(count && {count}), ...(sum && {sum}), ...(avg && {avg}) }. sum/avg operate over numeric values of docs that have the field; docs without it are skipped for sum/avg but still counted by count. Round avg to 2 decimals.
3) { $sort: { field: 'asc'|'desc' } } and { $limit: n } — same semantics as find().
Pipelines compose left to right. Do not mutate the collection. Inspect your work before replying.`,
    verifier: (ws) => verifierSource(ws, `
const { MiniDB } = await import(__WS__ + '/src/db.ts')
const db = new MiniDB()
const col = db.createCollection('sales')
for (const s of [
  { region: 'east', amount: 100 },
  { region: 'east', amount: 50 },
  { region: 'west', amount: 200 },
]) col.insert(s)
const grouped = col.aggregate([
  { $match: { amount: { $gte: 0 } } },
  { $group: { by: 'region', count: true, sum: 'amount', avg: 'amount' } },
  { $sort: { _id: 'asc' } },
])
assert.deepEqual(grouped, [
  { _id: 'east', count: 2, sum: 150, avg: 75 },
  { _id: 'west', count: 1, sum: 200, avg: 200 },
])
assert.equal(col.aggregate([{ $limit: 2 }]).length, 2)
assert.equal(col.count(), 3)
`),
  },
  {
    slug: 'schema-validation',
    title: 'Optional schema validation',
    prompt: `Add schema validation to Collection in src/db.ts:
1) setSchema(schema | null): schema is { fields: { [field]: { type: 'string'|'number'|'boolean'|'object'|'array', required?: boolean, enum?: unknown[] } } }.
2) While a schema is set, insert() and update() must validate: wrong type → throw /invalid type/i; missing required field on insert → throw /required/i; a field present but not in enum → throw /enum/i.
3) Fields not mentioned in the schema are unconstrained. Setting a schema does NOT retroactively validate existing docs.
4) setSchema(null) removes validation entirely.
5) Validation errors must be thrown BEFORE any state change (failed insert leaves collection unchanged). Inspect your work before replying.`,
    verifier: (ws) => verifierSource(ws, `
const { MiniDB } = await import(__WS__ + '/src/db.ts')
const db = new MiniDB()
const col = db.createCollection('employees')
col.setSchema({ fields: {
  name: { type: 'string', required: true },
  age: { type: 'number' },
  role: { type: 'string', enum: ['staff', 'admin'] },
}})
const id = col.insert({ name: 'ann', age: 30, role: 'admin' })
assert.throws(() => col.insert({ name: 42 }), /invalid type|required/i)
assert.throws(() => col.insert({ age: 5 }), /required/i)
assert.throws(() => col.insert({ name: 'x', role: 'boss' }), /enum/i)
assert.throws(() => { const doc = col.get(id); doc.age = 'old'; col.update(id, doc) }, /invalid type/i)
assert.equal(col.count(), 1)
col.setSchema(null)
assert.doesNotThrow(() => col.insert({ whatever: true }))
`),
  },
  {
    slug: 'durability-reload',
    title: 'Durability edge cases and export/import',
    prompt: `Harden persistence in src/db.ts:
1) Loading a corrupt/unparseable file in the constructor must throw an Error containing /corrupt/i (never silently start empty).
2) db.exportJson(): string — serializes ALL collections, docs, indexes (fields+unique flags) and schemas into one JSON string. db.importJson(json): void — replaces current content with the parsed snapshot, rebuilding indexes and schemas so their behavior continues to work (unique violations still enforced afterwards). Malformed input throws /corrupt/i.
3) Reopening from file restores unique-index enforcement: insert dup → still throws.
4) save() remains compatible. Inspect your work before replying.`,
    verifier: (ws) => verifierSource(ws, `
const { MiniDB } = await import(__WS__ + '/src/db.ts')
const fs = await import('node:fs/promises')
const os = await import('node:os')
const path = await import('node:path')
const bad = path.join(os.tmpdir(), 'minidb-bad-' + Date.now() + '.json')
await fs.writeFile(bad, '{oops')
assert.throws(() => new MiniDB({ file: bad }), /corrupt/i)
await fs.rm(bad, { force: true })
const db = new MiniDB()
const col = db.createCollection('users')
col.setSchema({ fields: { name: { type: 'string', required: true } } })
col.createIndex('name', { unique: true })
const id = col.insert({ name: 'ann' })
const snapshot = db.exportJson()
const db2 = new MiniDB()
db2.importJson(snapshot)
const users2 = db2.collection('users')
assert.equal(users2.get(id).name, 'ann')
assert.throws(() => users2.insert({ name: 'ann' }), /duplicate/i)
await fs.writeFile(bad, 'nope')
assert.throws(() => db2.importJson('nope'), /corrupt/i)
await fs.rm(bad, { force: true })
`),
  },
  {
    slug: 'pluggable-backends',
    title: 'Pluggable backends refactor',
    prompt: `Refactor internals of src/db.ts to support pluggable backends WITHOUT changing the public API:
1) Support constructor options { backend: 'memory' | 'file', file?: string }. backend:'memory' keeps everything in-process (save()/load no-ops unless a file was ALSO provided via the legacy form). The legacy shape { file } maps to backend:'file'.
2) Both backends must behave identically for every feature built so far (collections, queries, indexes, transactions, schemas, export/import).
3) Structure the code internally so backend selection lives in ONE place (e.g., a small storage interface) rather than scattered conditionals — reviewers will read this code.
4) All previous behaviors and error messages keep working. Inspect your work before replying.`,
    verifier: (ws) => verifierSource(ws, `
const { MiniDB } = await import(__WS__ + '/src/db.ts')
const mem = new MiniDB({ backend: 'memory' })
mem.createCollection('c')
mem.collection('c').createIndex('k', { unique: true })
mem.collection('c').insert({ k: 'v' })
assert.throws(() => mem.collection('c').insert({ k: 'v' }))
const tx = mem.beginTransaction()
tx.collection('c').insert({ k: 'z' })
tx.rollback()
assert.equal(mem.collection('c').count(), 1)
const legacy = new MiniDB()
legacy.createCollection('c')
legacy.collection('c').insert({ ok: true })
assert.equal(legacy.collection('c').count(), 1)
`),
  },
  {
    slug: 'atomic-batches',
    title: 'Atomic batch apply',
    prompt: `Final stage: add db.applyBatch(ops) where ops is an array of:
{ op: 'insert', collection: name, doc } → returns generated id
{ op: 'update', collection: name, id, patch } → merge patch
{ op: 'delete', collection: name, id }
Semantics:
1) Atomicity: if ANY op is invalid (unknown collection, unknown op type, missing target id, schema violation, unique violation), NOTHING is applied and the result is { applied: false, error } where error describes the first problem.
2) On success: { applied: true, results } where results holds per-op outcomes (ids for inserts, true for update/delete).
3) Batches participate in transactional isolation exactly like beginTransaction mutations (readers see nothing until the batch completes).
4) Empty ops array → { applied: true, results: [] }.
Inspect your work before replying.`,
    verifier: (ws) => verifierSource(ws, `
const { MiniDB } = await import(__WS__ + '/src/db.ts')
const db = new MiniDB()
const users = db.createCollection('users')
users.setSchema({ fields: { name: { type: 'string', required: true } } })
const good = db.applyBatch([
  { op: 'insert', collection: 'users', doc: { name: 'a' } },
  { op: 'insert', collection: 'users', doc: { name: 'b' } },
])
assert.equal(good.applied, true)
assert.equal(good.results.length, 2)
const idA = good.results[0].id
const bad = db.applyBatch([
  { op: 'insert', collection: 'users', doc: { name: 'c' } },
  { op: 'insert', collection: 'users', doc: { noName: true } },
])
assert.equal(bad.applied, false)
assert.match(bad.error, /required|invalid/i)
assert.equal(users.count(), 2, 'failed batch must leave state untouched')
const gone = db.applyBatch([{ op: 'delete', collection: 'users', id: idA }])
assert.equal(gone.applied, true)
assert.equal(users.count(), 1)
const unknown = db.applyBatch([{ op: 'frobnicate', collection: 'users' }])
assert.equal(unknown.applied, false)
assert.equal(db.applyBatch([]).applied, true)
`),
  },
]

const fixtureHashInput = createHash('sha256')
fixtureHashInput.update(JSON.stringify(Object.fromEntries(fixtureEntries))).update(stages.map((stage) => stage.slug + stage.prompt).join('\0'))

async function createWorkspace(workspace: string): Promise<void> {
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  for (const [path, contents] of fixtureEntries) {
    const target = join(workspace, path)
    await mkdir(join(target, '..'), { recursive: true, mode: 0o700 })
    await writeFile(target, contents, { encoding: 'utf8', mode: 0o600 })
  }
  mustPass(await runCommand('git', ['init', '--quiet'], workspace, 15_000), 'git init')
  mustPass(await runCommand('git', ['add', '.'], workspace, 15_000), 'git add')
  mustPass(
    await runCommand(
      'git',
      ['-c', 'user.name=Marathon Benchmark', '-c', 'user.email=marathon@example.invalid', 'commit', '--quiet', '-m', 'initial spec'],
      workspace,
      15_000,
    ),
    'git commit',
  )
}

async function evaluateStage(workspace: string, stageIndex: number): Promise<StageEvaluation & { regressions: string[] }> {
  const checks: Record<string, Check> = {}
  const regressions: string[] = []
  // Cumulative: every earlier stage must still pass too.
  for (let prior = 0; prior <= stageIndex; prior += 1) {
    const stage = stages[prior]!
    const result = await runVerifier(workspace, stage)
    checks[`${prior === stageIndex ? 'behavior' : 'regression'}:${stage.slug}`] = toCheck(result)
    if (!result.passed && prior !== stageIndex) regressions.push(stage.slug)
  }
  const values = Object.values(checks)
  return { success: values.every((check) => check.passed), passedChecks: values.filter((check) => check.passed).length, totalChecks: values.length, checks, regressions }
}

async function runVerifier(workspace: string, stage: Stage): Promise<CommandResult> {
  const stagingDir = join(resultsDirectory, 'verifier-tmp')
  await mkdir(stagingDir, { recursive: true, mode: 0o700 })
  const verifierPath = join(stagingDir, `${stage.slug}-${randomBytes(4).toString('hex')}.mjs`)
  await writeFile(verifierPath, stage.verifier(workspace), { mode: 0o600 })
  try {
    return await runCommand(process.execPath, ['--import', 'tsx', verifierPath], project, 60_000)
  } finally {
    await rm(verifierPath, { force: true }).catch(() => undefined)
  }
}

function toCheck(result: CommandResult): Check {
  return { passed: result.passed, detail: result.passed ? 'ok' : compact(`${result.stderr} ${result.stdout}`, 400) }
}

// ---------------------------------------------------------------------------
// Runtime skeleton (concurrent arms, telemetry, verification guard).
// ---------------------------------------------------------------------------

type UsageSample = TokenUsage & { at: number }
type TaskTelemetry = { usageEvents: UsageSample[]; costs: number[]; toolCalls: number; compactions: number; errors: string[] }
type BenchmarkRuntime = { client: ReturnType<typeof createOpencodeClient>; close(): Promise<void> }
type LiveArm = {
  arm: Arm
  workspace: string
  paths: Awaited<ReturnType<typeof createRuntimePaths>>
  gateway: OpenCodeGateway
  opencode: BenchmarkRuntime
  tst?: TstRuntime
  sessionID: string
  permissions: Set<string>
  lastUsageAt?: number
  compactions: number
  errors: string[]
  results: StageResult[]
  current?: TaskTelemetry
}
const CACHE_IDLE_GAP_SECONDS = 180

function verifyRetryLimit(): number {
  const requested = Number(process.env.CUPPET_MARATHON_VERIFY_RETRIES ?? '2')
  return Number.isFinite(requested) ? Math.max(0, Math.min(3, Math.floor(requested))) : 2
}

async function main(): Promise<void> {
  if (process.env.CUPPET_MARATHON_SELFCHECK === '1') {
    const scratch = await mkdtemp(join('/private/tmp', 'cuppet-marathon-selfcheck-'))
    const workspace = join(scratch, 'workspace')
    await createWorkspace(workspace)
    process.stdout.write('selfcheck: applying reference implementation\n')
    await writeReferenceImplementation(workspace)
    let failures = 0
    for (let index = 0; index < stages.length; index += 1) {
      const evaluation = await evaluateStage(workspace, index)
      const status = evaluation.success ? 'passes' : `FAIL (${compact(JSON.stringify(evaluation.checks), 1400)})`
      process.stdout.write(`selfcheck: stage ${index + 1} ${stages[index]!.slug} → ${status}\n`)
      if (!evaluation.success) failures += 1
    }
    if (failures > 0) throw new Error(`${failures} stage verifiers reject the reference implementation`)
    process.stdout.write(`selfcheck ok: ${scratch}\n`)
    return
  }

  await mkdir(resultsDirectory, { recursive: true, mode: 0o700 })
  const assets = await resolveRuntimeAssets()
  if (!assets.opencode || !assets.tst || !assets.plugin) {
    throw new Error(`Cuppet runtime unavailable: ${assets.diagnostics.join('; ')}`)
  }
  const officialBinary = process.env.CUPPET_OFFICIAL_OPENCODE_BIN
    ?? '/private/tmp/cuppet-opencode-official-1.18.4/node_modules/opencode-darwin-arm64/bin/opencode'
  const officialVersion = await commandVersion(officialBinary)
  if (officialVersion.trim() !== OPENCODE_VERSION) {
    throw new Error(`Official OpenCode version mismatch: expected ${OPENCODE_VERSION}, received ${officialVersion || 'unknown'}`)
  }

  const root = await mkdtemp(join('/private/tmp', 'cuppet-marathon-'))
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const finalJsonPath = join(resultsDirectory, `ab-opencode-cuppet-marathon-${stamp}.json`)
  const finalMarkdownPath = join(resultsDirectory, `ab-opencode-cuppet-marathon-${stamp}.md`)
  const live = new Map<Arm, LiveArm>()
  const reports: Partial<Record<Arm, LiveArm>> = {}
  try {
    const order: Arm[] = ['opencode', 'cuppet']
    for (const arm of order) {
      const armRoot = join(root, arm)
      await mkdir(armRoot, { recursive: true, mode: 0o700 })
      live.set(arm, await startArm(arm, armRoot, { opencode: assets.opencode, tst: assets.tst, plugin: assets.plugin }, officialBinary))
    }

    const stageLimit = Math.max(1, Math.min(stages.length, Number(process.env.CUPPET_MARATHON_LIMIT ?? stages.length) || stages.length))
    for (let index = 0; index < stageLimit; index += 1) {
      const stage = stages[index]!
      process.stdout.write(`[${index + 1}/${stages.length}] ${stage.slug} · opencode+cuppet\n`)
      const outcomes = await Promise.allSettled(
        order.map(async (arm) => {
          const runtime = live.get(arm)
          if (!runtime) throw new Error(`${arm} runtime unavailable`)
          const result = await runStage(runtime, stage, index)
          return result
        }),
      )
      const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      if (failure) throw failure.reason
    }

    const report = buildReport(live, root)
    await writeAtomic(finalJsonPath, `${JSON.stringify(report, null, 2)}\n`)
    await writeAtomic(finalMarkdownPath, renderMarkdown(report))
    process.stdout.write(`Raw: ${finalJsonPath}\nSummary: ${finalMarkdownPath}\n`)
  } finally {
    for (const runtime of live.values()) {
      await runtime.gateway.close().catch(() => undefined)
      await runtime.opencode.close().catch(() => undefined)
      await runtime.tst?.close().catch(() => undefined)
    }
    if (!keepWorkspaces) await rm(root, { recursive: true, force: true }).catch(() => undefined)
    else process.stdout.write(`Artifacts retained: ${root}\n`)
  }
}

async function startArm(
  arm: Arm,
  root: string,
  assets: { opencode: string; tst: string; plugin: string },
  officialBinary: string,
): Promise<LiveArm> {
  const workspace = join(root, 'workspace')
  const runtimeRoot = join(root, 'runtime')
  await createWorkspace(workspace)
  const paths = await createRuntimePaths(workspace, runtimeRoot)
  await seedProviderState(paths)
  const logger = new RedactedLogger(paths.logs)
  let tst: TstRuntime | undefined
  let opencode: BenchmarkRuntime
  let gateway: OpenCodeGateway
  if (arm === 'cuppet') {
    tst = await startTstDaemon(assets.tst, paths, logger)
    await waitForIndex(tst)
    // Orchestrator mode (CUPPET_ORCHESTRATOR=1): the primary model becomes the
    // master — it retrieves context itself via explicit tools and delegates
    // implementation to the worker subagent on CUPPET_WORKER_MODEL.
    const orchestrator = process.env.CUPPET_ORCHESTRATOR === '1'
    const workerModel = parseRequestedModelFrom(process.env.CUPPET_WORKER_MODEL, process.env.CUPPET_WORKER_VARIANT)
    opencode = await startOpenCodeServer({
      binary: assets.opencode,
      paths,
      logger,
      plugin: assets.plugin,
      tst: { socket: tst.socket, token: tst.token },
      ...(orchestrator
        ? { orchestrator: true, secondaryModel: workerModel }
        : { taskContext: true, instructions: [DEFAULT_CUPPET_INSTRUCTION] }),
    })
    gateway = new OpenCodeGateway(opencode.client, workspace)
  } else {
    opencode = await startOfficialOpenCodeServer(officialBinary, paths, logger)
    gateway = new OpenCodeGateway(opencode.client, workspace, { foreground: 'build', background: 'general' })
  }
  const allowed = new Set([
    'read', 'edit', 'write', 'bash', 'glob', 'grep', 'lsp', 'question', 'todowrite',
    'cuppet_memory_search', 'cuppet_workspace_info', 'cuppet_graph_tree', 'cuppet_graph_search', 'cuppet_graph_trace',
  ])
  const session = await gateway.createSession(model)
  const runtime: LiveArm = {
    arm, workspace, paths, gateway, opencode, ...(tst ? { tst } : {}), sessionID: session.id,
    permissions: new Set(), lastUsageAt: undefined, compactions: 0, errors: [], results: [], current: undefined,
  }
  gateway.onEvent((event: AgentEvent) => {
    if (event.type === 'permission') {
      if (!runtime.permissions.has(event.request.id)) {
        runtime.permissions.add(event.request.id)
        void gateway.replyPermission(event.request.sessionID, event.request.id, allowed.has(event.request.action) ? 'once' : 'reject').catch(() => undefined)
      }
      return
    }
    const current = runtime.current
    if (!current) return
    if (event.type === 'usage') {
      const at = Date.now()
      runtime.lastUsageAt = at
      current.usageEvents.push({ at, ...event.usage })
      current.costs.push(event.cost)
    }
    if (event.type === 'tool-start') current.toolCalls += 1
    if (event.type === 'compaction' && event.phase === 'started') runtime.compactions += 1
    if (event.type === 'error') {
      current.errors.push(event.message)
      runtime.errors.push(event.message)
    }
  })
  gateway.startEvents()
  await delay(250)
  return runtime
}

async function runStage(runtime: LiveArm, stage: Stage, index: number): Promise<StageResult> {
  const telemetry: TaskTelemetry = { usageEvents: [], costs: [], toolCalls: 0, compactions: 0, errors: [] }
  runtime.current = telemetry
  const started = performance.now()
  let failure: string | undefined
  const sendAndSettle = async (prompt: string): Promise<boolean> => {
    try {
      await runtime.gateway.prompt(runtime.sessionID, prompt)
      await withTimeout(runtime.gateway.wait(runtime.sessionID), timeoutMs, `${runtime.arm}/${stage.slug} timed out`)
      return true
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      await runtime.gateway.interrupt(runtime.sessionID).catch(() => undefined)
      if (/model not found|usage limit|quota/i.test(failure)) throw new Error(`[${runtime.arm}] ${compact(failure, 200)}`)
      return false
    }
  }

  const retries = verifyRetryLimit()
  let attempts = 0
  let firstAttemptSuccess = false
  let evaluation: (Awaited<ReturnType<typeof evaluateStage>>) | undefined
  while (attempts <= retries) {
    const prompt = attempts === 0
      ? stage.prompt
      : repairPromptFor(stage, evaluation!)
    attempts += 1
    if (!await sendAndSettle(prompt)) break
    await delay(300)
    evaluation = await evaluateStage(runtime.workspace, index)
    if (attempts === 1) firstAttemptSuccess = evaluation.success
    if (evaluation.success || failure) break
    process.stdout.write(`  ${runtime.arm}/${stage.slug}: attempt ${attempts} failed (${evaluation.regressions.length} regressions), feeding back\n`)
  }
  evaluation ??= { success: false, passedChecks: 0, totalChecks: 0, checks: {}, regressions: [] }
  const usageFromEvents = usageFromEventList(telemetry.usageEvents, telemetry.costs)
  const steps = buildUsageSteps(telemetry.usageEvents, runtime.lastUsageAt)
  const error = failure ?? telemetry.errors[0] ?? (!evaluation.success ? 'acceptance checks failed' : undefined)
  const result: StageResult = {
    index: index + 1,
    slug: stage.slug,
    success: !error,
    attempts,
    firstAttemptSuccess,
    repaired: attempts > 1 && !firstAttemptSuccess && !error,
    regressions: evaluation.regressions,
    agentDurationMs: Math.round(performance.now() - started),
    usage: { ...usageFromEvents, ...(steps.length > 0 ? { steps } : {}) },
    toolCalls: telemetry.toolCalls,
    compactions: runtime.compactions,
    evaluation,
    ...(error ? { error: compact(error, 400) } : {}),
  }
  runtime.results.push(result)
  runtime.current = undefined
  return result
}

function repairPromptFor(stage: Stage, evaluation: Awaited<ReturnType<typeof evaluateStage>>): string {
  const lines: string[] = []
  for (let prior = 0; prior < stages.indexOf(stage); prior += 1) {
    const key = `regression:${stages[prior]!.slug}`
    if (evaluation.checks[key] && !evaluation.checks[key]!.passed) lines.push(`- REGRESSION in earlier stage '${stages[prior]!.slug}': ${compact(evaluation.checks[key]!.detail, 220)}`)
  }
  for (const [name, check] of Object.entries(evaluation.checks)) {
    if (name.startsWith('behavior:') && !check.passed) lines.push(`- ${stage.slug}: ${compact(check.detail, 260)}`)
  }
  return [
    'Your previous attempt did not fully satisfy the requirements. A deterministic verifier reported:',
    ...lines,
    'Fix only these verified problems WITHOUT breaking any earlier stage behavior, then re-inspect your changes and reply.',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Reference implementation used only by the self-check.
// ---------------------------------------------------------------------------

const REFERENCE_DB = String.raw`
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export class MiniDB {
  #data: Record<string, { docs: Record<string, any>; order: string[] }> = {}
  #indexes: Record<string, Record<string, { field: string; unique: boolean }>> = {}
  #schemas: Record<string, { fields: Record<string, any> } | null> = {}
  #counter: Record<string, number> = {}
  #backend: 'memory' | 'file'
  #file?: string
  #tx: { changes: Array<{ apply: () => void; revert: () => void }> } | null = null

  constructor(options?: { backend?: 'memory' | 'file'; file?: string }) {
    this.#backend = options?.backend ?? (options?.file ? 'file' : 'memory')
    this.#file = options?.file
    if (this.#backend === 'file' && this.#file) {
      if (existsSync(this.#file)) {
        let parsed: any
        try {
          parsed = JSON.parse(readFileSync(this.#file, 'utf8'))
        } catch {
          throw new Error('corrupt database file: ' + this.#file)
        }
        this.#hydrate(parsed)
      }
    }
  }

  #hydrate(parsed: any) {
    if (!parsed || typeof parsed !== 'object' || !parsed.collections) throw new Error('corrupt database file')
    this.#data = parsed.collections ?? {}
    this.#indexes = parsed.indexes ?? {}
    this.#schemas = parsed.schemas ?? {}
    this.#counter = parsed.counter ?? {}
  }

  #snapshot() {
    return JSON.parse(JSON.stringify({
      collections: this.#data,
      indexes: this.#indexes,
      schemas: this.#schemas,
      counter: this.#counter,
    }))
  }

  createCollection(name: string): Collection {
    if (!name) throw new Error('collection name is required')
    if (this.#data[name]) throw new Error('collection already exists: ' + name)
    this.#data[name] = { docs: {}, order: [] }
    this.#indexes[name] = {}
    this.#schemas[name] = null
    this.#record(() => { this.#data[name] = { docs: {}, order: [] }; this.#indexes[name] = {}; this.#schemas[name] = null },
                 () => { delete this.#data[name]; delete this.#indexes[name]; delete this.#schemas[name] })
    return new Collection(name, this)
  }

  collection(name: string): Collection | null {
    return this.#data[name] ? new Collection(name, this) : null
  }

  hasCollection(name: string): boolean { return Boolean(this.#data[name]) }

  dropCollection(name: string): boolean {
    if (!this.#data[name]) return false
    const backupData = this.#data[name]
    const backupIdx = this.#indexes[name]
    const backupSch = this.#schemas[name]
    delete this.#data[name]; delete this.#indexes[name]; delete this.#schemas[name]
    this.#record(() => { delete this.#data[name]; delete this.#indexes[name]; delete this.#schemas[name] },
                 () => { this.#data[name] = backupData; this.#indexes[name] = backupIdx; this.#schemas[name] = backupSch })
    return true
  }

  names(): string[] { return Object.keys(this.#data) }

  save(): void {
    if (this.#backend !== 'file' || !this.#file) return
    writeFileSync(this.#file, JSON.stringify(this.#snapshot()))
  }

  exportJson(): string { return JSON.stringify(this.#snapshot()) }

  importJson(json: string): void {
    let parsed: any
    try { parsed = JSON.parse(json) } catch { throw new Error('corrupt import payload') }
    if (!parsed || typeof parsed !== 'object' || !parsed.collections) throw new Error('corrupt import payload')
    const prev = { data: this.#data, idx: this.#indexes, sch: this.#schemas, ctr: this.#counter }
    this.#hydrate(parsed)
    for (const name of Object.keys(this.#data)) {
      const idx = this.#indexes[name] ?? {}
      for (const [key, meta] of Object.entries<any>(idx)) {
        if (!meta.unique) continue
        const seen = new Set<string>()
        for (const id of this.#data[name].order) {
          const v = this.#data[name].docs[id]?.[meta.field]
          if (v === undefined) continue
          if (seen.has(v)) throw new Error('duplicate key violates unique constraint: ' + key)
          seen.add(v)
        }
      }
    }
    this.#record(() => { /* committed via hydrate */ }, () => { this.#data = prev.data; this.#indexes = prev.idx; this.#schemas = prev.sch; this.#counter = prev.ctr })
  }

  beginTransaction(): Transaction {
    if (this.#tx) throw new Error('transaction already active')
    const tx: Transaction = new Transaction(this)
    return tx
  }

  applyBatch(ops: Array<any>): { applied: boolean; results?: Array<any>; error?: string } {
    if (!Array.isArray(ops)) return { applied: false, error: 'ops must be an array' }
    const tx = this.beginTransaction()
    const results: Array<any> = []
    try {
      for (const entry of ops) {
        if (!entry || typeof entry !== 'object' || !entry.op || !entry.collection || !this.hasCollection(entry.collection)) {
          throw new Error('invalid batch operation: ' + JSON.stringify(entry)?.slice(0, 120))
        }
        const col = tx.collection(entry.collection)
        if (entry.op === 'insert') {
          results.push({ id: col.insert(entry.doc) })
        } else if (entry.op === 'update') {
          if (!col.update(entry.id, entry.patch)) throw new Error('document not found: ' + entry.id)
          results.push(true)
        } else if (entry.op === 'delete') {
          if (!col.delete(entry.id)) throw new Error('document not found: ' + entry.id)
          results.push(true)
        } else {
          throw new Error('unsupported batch op: ' + entry.op)
        }
      }
      tx.commit()
      return { applied: true, results }
    } catch (error: any) {
      try { tx.rollback() } catch {}
      return { applied: false, error: error?.message ?? 'batch failed' }
    }
  }

  #record(apply: () => void, revert: () => void) {
    if (this.#tx) this.#tx.changes.push({ apply, revert })
    else apply()
  }

  // --- internal hooks used by Collection/Transaction ---
  __raw(name: string) { return this.#data[name] }
  __indexes(name: string) { return this.#indexes[name] ?? {} }
  __ensureIndexes(name: string) { if (!this.#indexes[name]) this.#indexes[name] = {}; return this.#indexes[name] }
  __schema(name: string) { return this.#schemas[name] }
  __schemaStore() { return this.#schemas }
  __counter(name: string) { return this.#counter }
  __beginTx() { this.#tx = { changes: [] } }
  __endTx() { this.#tx = null }
  __inTx() { return this.#tx }
  __recordTx(apply: () => void, revert: () => void) {
    if (this.#tx) this.#tx.changes.push({ apply, revert })
    else apply()
  }
  __commitTx() {
    if (!this.#tx) throw new Error('no active transaction')
    for (const change of this.#tx.changes) change.apply()
    this.#tx = null
    this.save()
  }
  __rollbackTx() {
    if (!this.#tx) throw new Error('no active transaction')
    // Queued changes were never applied while the transaction was open, so
    // rollback discards them instead of reverting anything.
    this.#tx = null
  }
}

class Transaction {
  #db: MiniDB
  #done = false
  constructor(db: MiniDB) { this.#db = db; db.__beginTx() }
  collection(name: string): Collection {
    if (this.#done) throw new Error('transaction already finished')
    if (!this.#db.hasCollection(name)) throw new Error('collection not found: ' + name)
    return new Collection(name, this.#db)
  }
  commit(): void {
    if (this.#done) throw new Error('transaction already finished')
    this.#done = true
    this.#db.__commitTx()
  }
  rollback(): void {
    if (this.#done) throw new Error('transaction already finished')
    this.#done = true
    this.#db.__rollbackTx()
  }
}

class Collection {
  #name: string
  #db: MiniDB
  constructor(name: string, db: MiniDB) { this.#name = name; this.#db = db }
  #clone<T>(value: T): T { return structuredClone(value) }
  #validateInsert(doc: any) {
    const schema = this.#db.__schema(this.#name)
    if (!schema) return
    for (const [field, rule] of Object.entries<any>(schema.fields)) {
      const present = Object.prototype.hasOwnProperty.call(doc, field) && doc[field] !== undefined
      if (rule.required && !present) throw new Error('field is required: ' + field)
      if (!present) continue
      const actual = Array.isArray(doc[field]) ? 'array' : typeof doc[field]
      if (actual !== rule.type) throw new Error('invalid type for ' + field + ': expected ' + rule.type)
      if (rule.enum && !rule.enum.includes(doc[field])) throw new Error('value not in enum for ' + field)
    }
  }
  #validateUpdate(patch: any) {
    const schema = this.#db.__schema(this.#name)
    if (!schema) return
    for (const [field, rule] of Object.entries<any>(schema.fields)) {
      if (!Object.prototype.hasOwnProperty.call(patch, field) || patch[field] === undefined) continue
      const actual = Array.isArray(patch[field]) ? 'array' : typeof patch[field]
      if (actual !== rule.type) throw new Error('invalid type for ' + field + ': expected ' + rule.type)
      if (rule.enum && !rule.enum.includes(patch[field])) throw new Error('value not in enum for ' + field)
    }
  }
  #checkUnique(field: string, value: any, ignoreId?: string) {
    for (const meta of Object.values<any>(this.#db.__indexes(this.#name))) {
      if (meta.field !== field || !meta.unique) continue
      for (const [id, doc] of Object.entries<any>(this.#db.__raw(this.#name).docs)) {
        if (id === ignoreId) continue
        if (doc[field] === value) throw new Error('duplicate key violates unique constraint: ' + field)
      }
    }
  }
  insert(doc: any): string {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('document must be an object')
    this.#validateInsert(doc)
    const counter = this.#db.__counter(this.#name)
    counter[this.#name] = (counter[this.#name] ?? 0) + 1
    const id = this.#name.slice(0, 1) + counter[this.#name]
    const stored = this.#clone({ ...doc, _id: id })
    for (const [field, value] of Object.entries(stored)) {
      if (field === '_id') continue
      this.#checkUnique(field, value)
    }
    const raw = this.#db.__raw(this.#name)
    this.#db.__recordTx(
      () => { raw.docs[id] = stored; raw.order.push(id) },
      () => { delete raw.docs[id]; const at = raw.order.indexOf(id); if (at >= 0) raw.order.splice(at, 1); counter[this.#name] -= 1 },
    )
    return id
  }
  get(id: string): any | undefined {
    const doc = this.#db.__raw(this.#name)?.docs[id]
    return doc ? this.#clone(doc) : undefined
  }
  all(): any[] {
    return (this.#db.__raw(this.#name)?.order ?? []).map((id) => this.#clone(this.#db.__raw(this.#name).docs[id]))
  }
  count(): number { return this.#db.__raw(this.#name)?.order.length ?? 0 }
  delete(id: string): boolean {
    const raw = this.#db.__raw(this.#name)
    if (!raw || !raw.docs[id]) return false
    const stored = raw.docs[id]
    const at = raw.order.indexOf(id)
    this.#db.__recordTx(
      () => { delete raw.docs[id]; const i = raw.order.indexOf(id); if (i >= 0) raw.order.splice(i, 1) },
      () => { raw.docs[id] = stored; raw.order.splice(Math.min(at, raw.order.length), 0, id) },
    )
    return true
  }
  update(id: string, patch: any): boolean {
    const raw = this.#db.__raw(this.#name)
    if (!raw || !raw.docs[id]) return false
    if (!patch || typeof patch !== 'object') throw new Error('patch must be an object')
    this.#validateUpdate(patch)
    for (const [field, value] of Object.entries(patch)) {
      if (field === '_id') continue
      this.#checkUnique(field, value, id)
    }
    const prev = this.#clone(raw.docs[id])
    this.#db.__recordTx(
      () => { raw.docs[id] = { ...structuredClone(raw.docs[id]), ...structuredClone(patch) } },
      () => { raw.docs[id] = prev },
    )
    return true
  }
  find(options: { filter?: any; sort?: any; projection?: any; limit?: number } = {}): any[] {
    let docs = this.all()
    if (options.filter) {
      docs = docs.filter((doc) => matchFilter(doc, options.filter))
    }
    if (options.sort) {
      const entries = Object.entries<any>(options.sort)
      docs.sort((left, right) => {
        for (const [field, direction] of entries) {
          const lv = left[field]; const rv = right[field]
          const lMissing = lv === undefined; const rMissing = rv === undefined
          if (lMissing && rMissing) continue
          if (lMissing) return 1
          if (rMissing) return -1
          if (lv === rv) continue
          const cmp = lv > rv ? 1 : -1
          return direction === 'desc' ? -cmp : cmp
        }
        return 0
      })
    }
    if (options.projection) {
      const include = Object.keys(options.projection).filter((field) => options.projection[field])
      docs = docs.map((doc) => {
        const out: any = {}
        for (const field of include) if (Object.prototype.hasOwnProperty.call(doc, field)) out[field] = doc[field]
        if (include.includes('_id') || true) out._id = doc._id
        return out
      })
    }
    if (typeof options.limit === 'number' && options.limit > 0) docs = docs.slice(0, options.limit)
    return docs
  }
  setSchema(schema: any): void {
    if (schema !== null && (typeof schema !== 'object' || !schema.fields || typeof schema.fields !== 'object')) {
      throw new Error('invalid schema')
    }
    const store = this.#db.__schemaStore()
    const previous = store[this.#name] ?? null
    this.#db.__recordTx(
      () => { store[this.#name] = schema ? structuredClone(schema) : null },
      () => { store[this.#name] = previous },
    )
  }
  aggregate(pipeline: Array<any>): any[] {
    let docs = this.all()
    for (const stageEntry of pipeline ?? []) {
      if (stageEntry.$match !== undefined) docs = docs.filter((doc) => matchFilter(doc, stageEntry.$match))
      else if (stageEntry.$group !== undefined) {
        const { by, count, sum, avg } = stageEntry.$group
        const buckets = new Map<any, any[]>()
        for (const doc of docs) {
          const key = typeof by === 'function' ? by(doc) : doc[by]
          if (!buckets.has(key)) buckets.set(key, [])
          buckets.get(key).push(doc)
        }
        docs = [...buckets.entries()].map(([key, group]) => {
          const out: any = { _id: key }
          if (count) out.count = group.length
          if (sum) out.sum = group.reduce((total, doc) => (typeof doc[sum] === 'number' ? total + doc[sum] : total), 0)
          if (avg) {
            const nums = group.map((doc) => doc[avg]).filter((v) => typeof v === 'number')
            out.avg = nums.length === 0 ? 0 : Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100
          }
          return out
        })
      } else if (stageEntry.$sort !== undefined) {
        docs = this.find({ sort: stageEntry.$sort, filter: {} }) && sortDocs(docs, stageEntry.$sort)
      } else if (stageEntry.$limit !== undefined) {
        docs = docs.slice(0, stageEntry.$limit)
      }
    }
    return docs
  }
  createIndex(field: string, options: { unique?: boolean } = {}): void {
    if (!field) throw new Error('field is required')
    if (options.unique) {
      const seen = new Set<any>()
      for (const doc of this.all()) {
        const value = doc[field]
        if (value === undefined) continue
        if (seen.has(value)) throw new Error('duplicate key violates unique constraint: ' + field)
        seen.add(value)
      }
    }
    const registry = this.#db.__ensureIndexes(this.#name)
    const previous = registry[field]
    this.#db.__recordTx(
      () => { registry[field] = { field, unique: Boolean(options.unique) } },
      () => { if (previous === undefined) delete registry[field]; else registry[field] = previous },
    )
  }
  dropIndex(field: string): boolean {
    const registry = this.#db.__indexes(this.#name)
    if (!registry || !(field in registry)) return false
    delete registry[field]
    return true
  }
}

function matchFilter(doc: any, filter: any): boolean {
  for (const [field, matcher] of Object.entries<any>(filter ?? {})) {
    const value = doc[field]
    if (matcher === null || typeof matcher !== 'object' || Array.isArray(matcher)) {
      if (!(value === matcher)) return false
      continue
    }
    for (const [op, expected] of Object.entries<any>(matcher)) {
      switch (op) {
        case '$eq': if (!(value === expected)) return false; break
        case '$ne': if (!(!(value === expected))) return false; break
        case '$gt': if (!(typeof value !== 'undefined' && value > expected)) return false; break
        case '$gte': if (!(typeof value !== 'undefined' && value >= expected)) return false; break
        case '$lt': if (!(typeof value !== 'undefined' && value < expected)) return false; break
        case '$lte': if (!(typeof value !== 'undefined' && value <= expected)) return false; break
        case '$in': if (!(Array.isArray(expected) && expected.includes(value))) return false; break
        default: throw new Error('unknown operator: ' + op)
      }
    }
  }
  return true
}

function sortDocs(docs: any[], sort: any): any[] {
  const entries = Object.entries<any>(sort ?? {})
  return [...docs].sort((left, right) => {
    for (const [field, direction] of entries) {
      const lv = left[field]; const rv = right[field]
      if (lv === undefined && rv === undefined) continue
      if (lv === undefined) return 1
      if (rv === undefined) return -1
      if (lv === rv) continue
      const cmp = lv > rv ? 1 : -1
      return direction === 'desc' ? -cmp : cmp
    }
    return 0
  })
}
`;

async function writeReferenceImplementation(workspace: string): Promise<void> {
  await mkdir(join(workspace, 'src'), { recursive: true, mode: 0o700 })
  await writeFile(join(workspace, 'src/db.ts'), REFERENCE_DB.trimStart() + '\n', { encoding: 'utf8', mode: 0o600 })
  await writeFile(
    join(workspace, 'src/cli.ts'),
    `import type { MiniDB } from './db.js'

export function runReplCommand(db: MiniDB, line: string): string {
  try {
    const parts = line.trim().split(/\\s+/)
    const command = parts[0]
    switch (command) {
      case '.create': {
        const name = parts[1] ?? ''
        db.createCollection(name)
        return 'created ' + name
      }
      case '.drop': {
        return db.dropCollection(parts[1] ?? '') ? 'dropped ' + parts[1] : 'not found'
      }
      case '.insert': {
        const col = db.collection(parts[1] ?? '')
        if (!col) return 'error: collection not found'
        return 'inserted ' + col.insert(JSON.parse(parts.slice(2).join(' ')))
      }
      case '.get': {
        const doc = db.collection(parts[1] ?? '')?.get(parts[2] ?? '')
        return doc ? JSON.stringify(doc) : 'not found'
      }
      case '.find': {
        const col = db.collection(parts[1] ?? '')
        if (!col) return 'error: collection not found'
        const filter = parts[2] ? JSON.parse(parts.slice(2).join(' ')) : undefined
        return JSON.stringify(filter ? col.find({ filter }) : col.all())
      }
      case '.update': {
        const col = db.collection(parts[1] ?? '')
        if (!col) return 'error: collection not found'
        return col.update(parts[2] ?? '', JSON.parse(parts.slice(3).join(' '))) ? 'updated ' + parts[2] : 'not found'
      }
      case '.delete': {
        const col = db.collection(parts[1] ?? '')
        if (!col) return 'error: collection not found'
        return col.delete(parts[2] ?? '') ? 'deleted ' + parts[2] : 'not found'
      }
      case '.stats': {
        return db.names().map((name) => name + ': ' + (db.collection(name)?.count() ?? 0)).join('\\n')
      }
      default:
        return 'error: unknown command ' + String(command)
    }
  } catch (error: any) {
    return 'error: ' + String(error?.message ?? error)
  }
}
`,
    { encoding: 'utf8', mode: 0o600 },
  )
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

function buildReport(live: Map<Arm, LiveArm>, artifacts: string) {
  const summarize = (runtime: LiveArm | undefined) => {
    const values = runtime?.results ?? []
    const usage = values.reduce((sum, stage) => addUsage(sum, stage.usage), zeroUsage())
    return {
      stagesCompleted: values.length,
      successes: values.filter((stage) => stage.success).length,
      firstAttemptSuccesses: values.filter((stage) => stage.firstAttemptSuccess).length,
      repairedStages: values.filter((stage) => stage.repaired).length,
      regressionStages: values.filter((stage) => stage.regressions.length > 0).length,
      totalAgentDurationMs: values.reduce((sum, stage) => sum + stage.agentDurationMs, 0),
      uncachedInput: usage.input,
      cacheRead: usage.cacheRead,
      totalModelTokens: usage.totalModel,
      cacheShare: usage.input + usage.cacheRead === 0 ? 0 : usage.cacheRead / (usage.input + usage.cacheRead),
      adjustedCacheShare: (() => {
        let input = 0
        let read = 0
        for (const stage of values) {
          for (const step of stage.usage.steps ?? []) {
            if (step.gapSeconds === undefined || step.gapSeconds > CACHE_IDLE_GAP_SECONDS) continue
            input += step.input
            read += step.cacheRead
          }
        }
        return input + read === 0 ? 0 : read / (input + read)
      })(),
      toolCalls: values.reduce((sum, stage) => sum + stage.toolCalls, 0),
      compactions: runtime?.compactions ?? 0,
      passedChecks: values.reduce((sum, stage) => sum + stage.evaluation.passedChecks, 0),
      totalChecks: values.reduce((sum, stage) => sum + stage.evaluation.totalChecks, 0),
      errors: runtime?.errors ?? [],
    }
  }
  const opencode = summarize(live.get('opencode'))
  const cuppet = summarize(live.get('cuppet'))
  const ratio = (numerator: number, denominator: number) => (denominator === 0 ? 0 : numerator / denominator)
  return {
    schema: 1,
    createdAt: new Date().toISOString(),
    model,
    stages: stages.map((stage) => stage.slug),
    artifacts,
    arms: {
      opencode: { results: live.get('opencode')?.results ?? [], summary: opencode },
      cuppet: { results: live.get('cuppet')?.results ?? [], summary: cuppet },
    },
    summary: {
      opencode,
      cuppet,
      comparison: {
        successDelta: cuppet.successes - opencode.successes,
        timeReduction: ratio(opencode.totalAgentDurationMs - cuppet.totalAgentDurationMs, opencode.totalAgentDurationMs),
        uncachedInputReduction: ratio(opencode.uncachedInput - cuppet.uncachedInput, opencode.uncachedInput),
        totalTokenReduction: ratio(opencode.totalModelTokens - cuppet.totalModelTokens, opencode.totalModelTokens),
        toolCallReduction: ratio(opencode.toolCalls - cuppet.toolCalls, opencode.toolCalls),
        checkDelta: cuppet.passedChecks - opencode.passedChecks,
      },
    },
  }
}

function signedPct(reduction: number): string {
  return `${reduction >= 0 ? '−' : '+'}${Math.abs(reduction * 100).toFixed(1)}%${reduction < 0 ? ' (more)' : ''}`
}

function renderMarkdown(report: ReturnType<typeof buildReport>): string {
  const { opencode, cuppet, comparison } = report.summary
  const rows = report.stages.map((slug, index) => {
    const official = report.arms.opencode.results[index]
    const candidate = report.arms.cuppet.results[index]
    const cell = (value?: StageResult) =>
      value
        ? `${value.success ? 'pass' : 'FAIL'}${value.repaired ? '*' : ''}${value.regressions.length > 0 ? '!' : ''} · ${Math.round(value.agentDurationMs / 1000)}s · tok ${value.usage.totalModel.toLocaleString()} · ${value.attempts} attempt(s)`
        : 'missing'
    return `| ${index + 1}. ${slug} | ${cell(official)} | ${cell(candidate)} |`
  })
  return [
    `# Marathon A/B: OpenCode vs Cuppet — 10-stage MiniDB build`,
    '',
    `- Created: ${report.createdAt}`,
    `- Model: \`${report.model.providerID}/${report.model.modelID}\`${report.model.variant ? ` @${report.model.variant}` : ''}`,
    `- One persistent session per arm; stages build cumulatively; every stage verifies the full history (regressions marked !).`,
    '',
    '| Metric | OpenCode | Cuppet | Cuppet delta |',
    '|---|---:|---:|---:|',
    `| Stages correct | ${opencode.successes}/${opencode.stagesCompleted} | ${cuppet.successes}/${cuppet.stagesCompleted} | ${comparison.successDelta >= 0 ? '+' : ''}${comparison.successDelta} |`,
    `| First-attempt correct | ${opencode.firstAttemptSuccesses} | ${cuppet.firstAttemptSuccesses} | |`,
    `| Repairs needed | ${opencode.repairedStages} | ${cuppet.repairedStages} | |`,
    `| Regressed stages | ${opencode.regressionStages} | ${cuppet.regressionStages} | |`,
    `| Total agent time | ${(opencode.totalAgentDurationMs / 1000).toFixed(0)} s | ${(cuppet.totalAgentDurationMs / 1000).toFixed(0)} s | ${(comparison.timeReduction * 100).toFixed(1)}% |`,
    `| Uncached input | ${opencode.uncachedInput.toLocaleString()} | ${cuppet.uncachedInput.toLocaleString()} | ${(comparison.uncachedInputReduction * 100).toFixed(1)}% |`,
    `| Total model tokens | ${opencode.totalModelTokens.toLocaleString()} | ${cuppet.totalModelTokens.toLocaleString()} | −${(comparison.totalTokenReduction * 100).toFixed(1)}% |`,
    `| Tool calls | ${opencode.toolCalls} | ${cuppet.toolCalls} | −${(comparison.toolCallReduction * 100).toFixed(1)}% |`,
    `| Cache share | ${(opencode.cacheShare * 100).toFixed(1)}% | ${(cuppet.cacheShare * 100).toFixed(1)}% | |`,
    `| Compactions | ${opencode.compactions} | ${cuppet.compactions} | |`,
    `| Acceptance checks | ${opencode.passedChecks}/${opencode.totalChecks} | ${cuppet.passedChecks}/${cuppet.totalChecks} | ${comparison.checkDelta >= 0 ? '+' : ''}${comparison.checkDelta} |`,
    '',
    '| Stage | OpenCode | Cuppet |',
    '|---|---|---|',
    ...rows,
    '',
    '* = recovered by verification guard. ! = broke at least one earlier stage.',
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

function usageFromCuppet(value: TokenUsage): UsageStats {
  const totalModel = value.input + value.output + value.reasoning
  return { input: value.input, output: value.output, reasoning: value.reasoning, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite, totalModel, totalWithCache: totalModel + value.cacheRead + value.cacheWrite }
}
function zeroUsage(): UsageStats {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalModel: 0, totalWithCache: 0 }
}
function addUsage(left: UsageStats, right: UsageStats): UsageStats {
  const input = left.input + right.input
  const output = left.output + right.output
  const reasoning = left.reasoning + right.reasoning
  const cacheRead = left.cacheRead + right.cacheRead
  const cacheWrite = left.cacheWrite + right.cacheWrite
  const totalModel = input + output + reasoning
  return { input, output, reasoning, cacheRead, cacheWrite, totalModel, totalWithCache: totalModel + cacheRead + cacheWrite }
}
function usageFromEventList(events: UsageSample[], costs: number[]): StageUsage {
  const usage = events.reduce((sum, value) => addUsage(sum, usageFromCuppet(value)), zeroUsage())
  return { ...usage, eventCount: events.length, cost: costs.reduce((sum, value) => sum + value, 0) }
}
function buildUsageSteps(events: UsageSample[], priorAt: number | undefined): UsageStep[] {
  return events.map((sample, index) => {
    const previousAt = index > 0 ? events[index - 1]!.at : priorAt
    const gapSeconds = previousAt === undefined ? undefined : Math.max(0, Math.round((sample.at - previousAt) / 1000))
    return { gapSeconds, ...usageFromCuppet(sample) }
  })
}
async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(join(root, prefix), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const path = join(prefix, entry.name)
    if (entry.isDirectory()) files.push(...await listFiles(root, path))
    else if (entry.isFile()) files.push(path)
  }
  return files.sort()
}
async function runCommand(command: string, args: string[], cwd: string, timeout: number): Promise<CommandResult> {
  const started = performance.now()
  try {
    const result = await execFile(command, args, { cwd, env: { ...process.env, CI: '1', NO_COLOR: '1' }, timeout, maxBuffer: 1_000_000 })
    return { passed: true, code: 0, stdout: result.stdout, stderr: result.stderr, durationMs: Math.round(performance.now() - started) }
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string }
    return { passed: false, code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message, durationMs: Math.round(performance.now() - started) }
  }
}
function mustPass(result: CommandResult, label: string): void {
  if (!result.passed) throw new Error(`${label} failed: ${compact(`${result.stderr} ${result.stdout}`, 500)}`)
}
async function commandVersion(command: string): Promise<string> {
  const result = await runCommand(command, ['--version'], project, 10_000)
  return compact(`${result.stdout} ${result.stderr}`, 300)
}
function compact(value: string, limit: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit)
}
function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}
function withTimeout<T>(promise: Promise<T>, timeout: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), timeout)
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value) },
      (error) => { clearTimeout(timer); rejectPromise(error) },
    )
  })
}
async function writeAtomic(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
}
async function seedProviderState(paths: Awaited<ReturnType<typeof createRuntimePaths>>): Promise<void> {
  const persistentRoot = join(homedir(), '.cuppet', 'v2', 'opencode')
  for (const [source, target] of [
    [join(persistentRoot, 'data', 'opencode', 'auth.json'), join(paths.opencode.data, 'opencode', 'auth.json')],
    [join(persistentRoot, 'cache', 'opencode', 'models.json'), join(paths.opencode.cache, 'opencode', 'models.json')],
  ] as const) {
    try {
      await mkdir(join(target, '..'), { recursive: true, mode: 0o700 })
      await writeFile(target, await readFile(source), { mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
async function waitForIndex(runtime: TstRuntime): Promise<void> {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const status = await runtime.client.call<{ graph?: { progress?: { complete?: boolean } } }>('status')
    if (status.graph?.progress?.complete) return
    await delay(100)
  }
  throw new Error('TST graph index timed out')
}
async function startOfficialOpenCodeServer(binary: string, paths: Awaited<ReturnType<typeof createRuntimePaths>>, logger: RedactedLogger): Promise<BenchmarkRuntime> {
  const username = 'marathon-opencode-arm'
  const password = randomBytes(32).toString('base64url')
  const config = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    default_agent: 'build',
    server: { mdns: false },
    experimental: { openTelemetry: false },
  }
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: paths.opencode.config,
    XDG_DATA_HOME: paths.opencode.data,
    XDG_CACHE_HOME: paths.opencode.cache,
    XDG_STATE_HOME: paths.opencode.state,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
  }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('CUPPET_')) delete environment[key]
  }
  const child = spawn(binary, ['serve', '--hostname=127.0.0.1', '--port=0', '--mdns=false'], {
    cwd: paths.projectRealpath,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: environment,
  })
  child.stderr?.on('data', (chunk: Buffer) => void logger.write('warn', `official opencode: ${chunk.toString('utf8')}`))
  try {
    const url = await waitForListening(child)
    const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
    const client = createOpencodeClient({ baseUrl: url, directory: paths.projectRealpath, headers: { authorization } })
    const health = await client.global.health({ throwOnError: true })
    if (!(health.data as { healthy?: boolean } | undefined)?.healthy) throw new Error('official OpenCode health check failed')
    return {
      client,
      async close() {
        try {
          await Promise.race([client.global.dispose({ throwOnError: true }), new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500))])
        } catch {}
        if (child.exitCode === null) child.kill('SIGTERM')
      },
    }
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGTERM')
    throw error
  }
}
function waitForListening(child: ChildProcess): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (!child.stdout) return rejectPromise(new Error('OpenCode stdout is unavailable'))
    const stdout = child.stdout
    let output = ''
    const timeout = setTimeout(() => {
      cleanup()
      rejectPromise(new Error(`Timed out waiting for OpenCode: ${compact(output, 500)}`))
    }, 15_000)
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8')
      for (const line of output.split(/\r?\n/)) {
        const match = /^opencode server listening on (https?:\/\/\S+)/.exec(line.trim())
        if (!match?.[1]) continue
        cleanup()
        resolvePromise(match[1])
        return
      }
    }
    const cleanup = () => {
      clearTimeout(timeout)
      stdout.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const onExit = (code: number | null) => { cleanup(); rejectPromise(new Error(`OpenCode exited ${code}`)) }
    const onError = (error: Error) => { cleanup(); rejectPromise(error) }
    stdout.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

main().catch((error) => {
  process.stderr.write(`Marathon benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
