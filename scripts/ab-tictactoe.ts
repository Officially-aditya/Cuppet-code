import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { join, relative, resolve, sep } from 'node:path'
import { PreferenceStore } from '../packages/cli/src/config/preferences.js'
import { OpenCodeGateway } from '../packages/cli/src/opencode/gateway.js'
import { startOpenCodeServer, type OpenCodeRuntime } from '../packages/cli/src/opencode/server.js'
import { resolveRuntimeAssets } from '../packages/cli/src/runtime/assets.js'
import { RedactedLogger } from '../packages/cli/src/runtime/logger.js'
import { createRuntimePaths } from '../packages/cli/src/runtime/paths.js'
import { buildCuppetContext } from '../packages/cli/src/tst/context.js'
import { startTstDaemon, type TstRuntime } from '../packages/cli/src/tst/supervisor.js'
import type { AgentEvent, ModelRef, TokenUsage } from '../packages/cli/src/types.js'
import { DEEPSEEK_HARNESS_CODING_SYSTEM_PROMPT, runDeepSeekHarness } from './lib/deepseek-harness.js'

type Arm = 'opencode' | 'cuppet' | 'deepseek-harness'
type Mark = 'X' | 'O'
type Cell = Mark | null
type Board = readonly Cell[]
type GameStatus = 'playing' | 'won' | 'draw'
type WinningLine = readonly [number, number, number]

type GameState = {
  board: Board
  currentPlayer: Mark
  status: GameStatus
  winner: Mark | null
  winningLine: WinningLine | null
  moves: number
}

type LooseState = {
  board: Board
  currentPlayer: Mark
  status: string
  winner?: Mark | null
  winningLine?: readonly number[] | null
  moves?: number
  moveCount?: number
}

type MoveResult =
  | { ok: true; state: GameState }
  | { ok: false; state: GameState; error: string }

type GameModule = {
  createGame?: (startingPlayer?: Mark) => LooseState
  makeMove?: (state: LooseState, index: number) => LooseState | MoveResult
  availableMoves?: (board: Board) => number[]
  getWinner?: (board: Board) => Mark | null | { winner: Mark | null; line?: readonly number[] | null; winningLine?: readonly number[] | null }
  chooseMove?: (state: LooseState, strategy?: string) => number
  getBestMove?: (state: LooseState) => number
  findBestMove?: (state: LooseState) => number
}

type Check = {
  passed: boolean
  detail: string
}

type CommandResult = {
  passed: boolean
  code: number | string
  durationMs: number
  stdout: string
  stderr: string
  timedOut?: boolean
}

type WorkspaceEvaluation = {
  acceptanceScore: number
  passedChecks: number
  totalChecks: number
  success: boolean
  checks: Record<string, Check>
  targetedTest: CommandResult
  typecheck: CommandResult
  cliSmoke: CommandResult
  hiddenContract: Check
}

type Trial = {
  repeat: number
  arm: Arm
  workspace: string
  sessionID: string
  success: boolean
  acceptanceScore: number
  contextTokens: number
  durationMs: number
  usage: TokenUsage
  uncachedInputTokens: number
  totalModelTokens: number
  modelCalls: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  toolCalls: number
  permissionRequests: number
  rejectedPermissions: number
  permissionActions: Array<{ action: string; resources: string[] }>
  answer: string
  evaluation: WorkspaceEvaluation
  error?: string
}

const execFileAsync = promisify(execFile)
const project = resolve(process.cwd())
const taskRepeats = Math.max(1, Math.min(5, Number(process.env.CUPPET_TTT_REPEATS ?? '2') || 2))
const benchmarkArms = parseArms(process.env.CUPPET_TTT_ARMS) ?? ['opencode', 'cuppet'] as [Arm, Arm]
const keepWorkspaces = process.env.CUPPET_TTT_KEEP_WORKSPACES === '1'
const allowExternalDirectory = process.env.CUPPET_TTT_ALLOW_EXTERNAL === '1'
const taskPrompt = `
Build a complete, playable Tic-Tac-Toe game from scratch in this repository.

Scope and constraints:
- Put the implementation under games/tic-tac-toe/.
- Use TypeScript and the existing Node 22 + tsx conventions. Do not add dependencies or use the network.
- Add a pure game engine in games/tic-tac-toe/src/game.ts with these exports:
  createGame(startingPlayer?: 'X' | 'O'), makeMove(state, index), availableMoves(board), and getWinner(board).
- The state must represent a 3x3 board, current player, playing/won/draw status, winner, winning line, and move count. Illegal, occupied, and post-game moves must be rejected without mutating the state.
- Add an AI in games/tic-tac-toe/src/ai.ts. It must take immediate wins, block immediate losses, and provide a perfect/minimax strategy that never loses.
- Add a terminal CLI in games/tic-tac-toe/src/cli.ts. It must render a readable board, accept squares 1-9, explain invalid input, support quitting, and expose --help without waiting for stdin.
- Add focused tests under games/tic-tac-toe/test/ covering legal/illegal moves, all win directions, draw detection, terminal-state behavior, and AI decisions.
- Add root npm scripts named game:test, game:typecheck, and game:play. The test script must run the Tic-Tac-Toe tests only; the typecheck script must typecheck the game; the play script must launch the CLI.

Workflow requirements:
1. Read and search the repository before editing so the implementation matches local conventions.
2. Implement the smallest coherent design, then run the focused tests and typecheck.
3. Fix any failures you find. Do not stop at a plan or a partial scaffold.
4. In your final response, list changed files and the exact validation commands/results.
5. Keep all edits inside the current trial workspace. Do not access credentials, use the network, or modify unrelated projects.
`

const assets = await resolveRuntimeAssets()
if (!assets.opencode || !assets.tst) {
  throw new Error(`Evaluation runtimes unavailable: ${assets.diagnostics.join('; ')}`)
}

const globalPreferences = new PreferenceStore(join(process.env.HOME ?? '', '.cuppet', 'v2', 'preferences.json'))
await globalPreferences.load()
const configuredModel = globalPreferences.value.primary
const model = parseModel(process.env.CUPPET_AB_MODEL) ?? configuredModel ?? {
  providerID: 'google-vertex',
  modelID: 'gemini-flash-latest',
}

const root = await mkdtemp(join('/private/tmp', 'cuppet-tictactoe-ab-'))
const trials: Trial[] = []

try {
  for (let repeat = 0; repeat < taskRepeats; repeat += 1) {
    const order: Arm[] = repeat % 2 === 0 ? benchmarkArms : [benchmarkArms[1], benchmarkArms[0]]
    for (const arm of order) {
      process.stdout.write(`\n[${repeat + 1}/${taskRepeats}] Tic-Tac-Toe coding task · ${arm}\n`)
      trials.push(await runTrial({ arm, model, repeat, root }))
    }
  }

  const summary = process.env.CUPPET_TTT_ARMS
    ? summarizePair(trials, benchmarkArms[0], benchmarkArms[1])
    : summarize(trials)
  const report = {
    schema: 2,
    createdAt: new Date().toISOString(),
    project,
    task: 'Create a complete TypeScript Tic-Tac-Toe game with engine, AI, CLI, tests, and scripts.',
    model,
    arms: benchmarkArms,
    kernel: { name: 'official OpenCode', version: '1.18.4' },
    design: 'paired fresh repository copies; identical task/model/tools/permissions; Cuppet adds bounded TST context; arm order alternates; mutations are isolated per trial',
    repeats: taskRepeats,
    summary,
    trials: trials.map((trial) => (keepWorkspaces ? trial : { ...trial, workspace: '<removed after evaluation>' })),
  }

  const resultsDirectory = resolve(project, 'benchmarks', 'results')
  await mkdir(resultsDirectory, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(':', '-')
  const jsonPath = join(resultsDirectory, `ab-tic-tac-toe-${stamp}.json`)
  const markdownPath = join(resultsDirectory, `ab-tic-tac-toe-${stamp}.md`)
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(
    markdownPath,
    process.env.CUPPET_TTT_ARMS
      ? renderPairMarkdown(report as Parameters<typeof renderPairMarkdown>[0])
      : renderMarkdown(report as Parameters<typeof renderMarkdown>[0]),
    'utf8',
  )

  process.stdout.write(`\n${JSON.stringify(report.summary, null, 2)}\n`)
  process.stdout.write(`Raw result: ${jsonPath}\nSummary: ${markdownPath}\n`)
} finally {
  if (!keepWorkspaces) await rm(root, { recursive: true, force: true }).catch(() => undefined)
}

async function runTrial(options: { arm: Arm; model: ModelRef; repeat: number; root: string }): Promise<Trial> {
  const workspace = join(options.root, `${options.arm}-${options.repeat + 1}`)
  await cloneProject(project, workspace)
  if (options.arm === 'deepseek-harness') return runDeepSeekTrial(options, workspace)
  const runtimeRoot = join(options.root, `runtime-${options.arm}-${options.repeat + 1}`)
  const paths = await createRuntimePaths(workspace, runtimeRoot)
  const logger = new RedactedLogger(paths.logs)
  let tst: TstRuntime | undefined
  let opencode: OpenCodeRuntime | undefined
  let gateway: OpenCodeGateway | undefined
  const errors = new Map<string, string>()
  const permissionRequests: string[] = []
  const permissionActions: Array<{ action: string; resources: string[] }> = []
  let rejectedPermissions = 0
  let toolCalls = 0
  let stepLimitHit = false

  try {
    tst = await startTstDaemon(assets.tst!, paths, logger)
    opencode = await startOpenCodeServer({
      binary: assets.opencode!,
      paths,
      logger,
      ...(assets.plugin ? { plugin: assets.plugin } : {}),
      tst: { socket: tst.socket, token: tst.token },
      ...(globalPreferences.value.vertexProject ? { vertexProject: globalPreferences.value.vertexProject } : {}),
    })
    gateway = new OpenCodeGateway(opencode.client, workspace)
    gateway.onEvent((event: AgentEvent) => {
      if (event.type === 'permission') {
        permissionRequests.push(event.request.action)
        permissionActions.push({ action: event.request.action, resources: [...event.request.resources] })
        const allowed = new Set(['read', 'edit', 'write', 'bash', 'glob', 'grep', 'lsp', 'question', 'todowrite', 'task'])
        const shouldAllow = allowed.has(event.request.action) || (allowExternalDirectory && event.request.action === 'external_directory')
        if (!shouldAllow) rejectedPermissions += 1
        void gateway
          ?.replyPermission(event.request.sessionID, event.request.id, shouldAllow ? 'once' : 'reject')
          .catch((error) => logger.write('warn', `benchmark permission reply failed: ${String(error)}`))
      }
      if (event.type === 'tool-start') toolCalls += 1
      if (event.type === 'step-limit') stepLimitHit = true
      if (event.type === 'error' && event.sessionID) errors.set(event.sessionID, event.message)
    })
    gateway.startEvents()
    await waitForIndex(tst)

    const session = await gateway.createSession(options.model)
    const enriched = options.arm === 'cuppet'
      ? await buildCuppetContext(tst.client, session.id, taskPrompt, 1_048_576, [], '', workspace)
      : { prompt: taskPrompt, contextTokens: 0 }
    const started = performance.now()
    let answer = ''
    let failure: string | undefined
    try {
      await gateway.prompt(session.id, enriched.prompt)
      await withTimeout(gateway.wait(session.id), 15 * 60_000, `${options.arm} Tic-Tac-Toe trial timed out`)
      answer = assistantText(await gateway.messages(session.id))
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      await gateway.interrupt(session.id).catch(() => undefined)
    }

    const completed = await gateway.getSession(session.id).catch(() => session)
    const evaluation = await evaluateWorkspace(workspace)
    const eventError = errors.get(session.id)
    const error = failure ?? eventError ?? (stepLimitHit ? 'step limit reached' : undefined)
    const success = !error && evaluation.success
    return {
      repeat: options.repeat + 1,
      arm: options.arm,
      workspace,
      sessionID: session.id,
      success,
      acceptanceScore: evaluation.acceptanceScore,
      contextTokens: enriched.contextTokens,
      durationMs: Math.round(performance.now() - started),
      usage: completed.tokens,
      uncachedInputTokens: completed.tokens.input,
      totalModelTokens: completed.tokens.input + completed.tokens.output + completed.tokens.reasoning,
      modelCalls: 0,
      cacheReadTokens: completed.tokens.cacheRead,
      cacheWriteTokens: completed.tokens.cacheWrite,
      cost: completed.cost,
      toolCalls,
      permissionRequests: permissionRequests.length,
      rejectedPermissions,
      permissionActions,
      answer,
      evaluation,
      ...(error ? { error } : {}),
    }
  } finally {
    gateway?.close()
    await opencode?.close().catch(() => undefined)
    await tst?.close().catch(() => undefined)
  }
}

async function runDeepSeekTrial(options: { arm: Arm; model: ModelRef; repeat: number; root: string }, workspace: string): Promise<Trial> {
  const started = performance.now()
  let sessionID = `deepseek-harness-${options.repeat + 1}`
  let answer = ''
  let usage = {
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    uncachedInputTokens: 0,
    totalModelTokens: 0,
    toolCalls: 0,
  }
  let error: string | undefined
  try {
    const result = await runDeepSeekHarness({
      workspace,
      sessionRoot: join(options.root, `sessions-deepseek-harness-${options.repeat + 1}`),
      model: options.model.modelID,
      provider: 'deepseek-official',
      baseURL: process.env.CUPPET_DSH_BASE_URL ?? 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY,
      maxTokens: 16_384,
      requestTimeoutMs: 10 * 60_000,
      systemPrompt: `${DEEPSEEK_HARNESS_CODING_SYSTEM_PROMPT}\nWorkspace root: ${workspace}. Use absolute paths under this directory only.`,
    }, taskPrompt)
    sessionID = result.sessionID
    answer = result.answer
    usage = result.usage
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure)
  }
  const evaluation = await evaluateWorkspace(workspace)
  return {
    repeat: options.repeat + 1,
    arm: options.arm,
    workspace,
    sessionID,
    success: !error && evaluation.success,
    acceptanceScore: evaluation.acceptanceScore,
    contextTokens: 0,
    durationMs: Math.round(performance.now() - started),
    usage: {
      input: usage.inputTokens,
      output: usage.outputTokens,
      reasoning: usage.reasoningTokens,
      cacheRead: usage.cacheReadTokens,
      cacheWrite: usage.cacheWriteTokens,
    },
    uncachedInputTokens: usage.uncachedInputTokens,
    totalModelTokens: usage.totalModelTokens,
    modelCalls: usage.modelCalls,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    cost: 0,
    toolCalls: usage.toolCalls,
    permissionRequests: 0,
    rejectedPermissions: 0,
    permissionActions: [],
    answer,
    evaluation,
    ...(error ? { error } : {}),
  }
}

async function cloneProject(source: string, destination: string): Promise<void> {
  const excluded = new Set(['.git', 'node_modules', 'target', 'dist', '.cuppet', '.benchmarks'])
  await cp(source, destination, {
    recursive: true,
    filter: (entry) => {
      const relativePath = relative(source, entry)
      if (!relativePath) return true
      const first = relativePath.split(sep)[0]
      return first ? !excluded.has(first) : true
    },
  })
  await symlink(join(source, 'node_modules'), join(destination, 'node_modules'), 'dir')
  if (process.env.CUPPET_TTT_ARMS) await rm(join(destination, 'games', 'tic-tac-toe'), { recursive: true, force: true })
}

async function evaluateWorkspace(workspace: string): Promise<WorkspaceEvaluation> {
  const files = await listFiles(workspace)
  const gameFiles = files.filter((file) => file.startsWith('games/tic-tac-toe/'))
  const packageValue = await readJson(join(workspace, 'package.json'))
  const scripts = packageValue?.scripts && typeof packageValue.scripts === 'object'
    ? packageValue.scripts as Record<string, unknown>
    : {}
  const sourceFiles = gameFiles.filter((file) => /\.(?:ts|tsx|js|mjs|cjs)$/.test(file))
  const sourceText = await Promise.all(sourceFiles.map((file) => readFile(join(workspace, file), 'utf8'))).then((values) => values.join('\n'))
  const engineSource = files.some((file) => /^games\/tic-tac-toe\/src\/game\.(?:ts|js|mjs|cjs)$/.test(file))
  const cliSource = files.some((file) => /^games\/tic-tac-toe\/src\/cli\.(?:ts|js|mjs|cjs)$/.test(file))
  const testsSource = files.some((file) => /^games\/tic-tac-toe\/test\/.*\.(?:test\.)?(?:ts|tsx|js|mjs|cjs)$/.test(file))
  const npmScripts = ['game:test', 'game:typecheck', 'game:play'].every((name) => typeof scripts[name] === 'string')
  const hiddenContract = await runHiddenContract(workspace, engineSource)
  const targetedTest = typeof scripts['game:test'] === 'string'
    ? await runCommand('npm', ['run', 'game:test'], workspace, 120_000)
    : failedCommand('game:test script is missing')
  const typecheck = typeof scripts['game:typecheck'] === 'string'
    ? await runCommand('npm', ['run', 'game:typecheck'], workspace, 120_000)
    : failedCommand('game:typecheck script is missing')
  const cliSmoke = typeof scripts['game:play'] === 'string'
    ? await runCommand('npm', ['run', 'game:play', '--', '--help'], workspace, 10_000)
    : failedCommand('game:play script is missing')

  const checks: Record<string, Check> = {
    engineSource: { passed: engineSource, detail: engineSource ? 'game engine file exists' : 'src/game.ts or src/game.js is missing' },
    cliSource: { passed: cliSource, detail: cliSource ? 'CLI file exists' : 'src/cli.ts or src/cli.js is missing' },
    testsSource: { passed: testsSource, detail: testsSource ? 'focused tests exist' : 'game tests are missing' },
    npmScripts: { passed: npmScripts, detail: npmScripts ? 'all three game scripts exist' : 'one or more game scripts are missing' },
    engineSignals: {
      passed: /createGame|makeMove|availableMoves|getWinner/.test(sourceText) && /winning|draw|occupied|currentPlayer/i.test(sourceText),
      detail: 'engine source contains the required state/move signals',
    },
    hiddenContract,
    targetedTests: { passed: targetedTest.passed, detail: summarizeCommand(targetedTest) },
    typecheck: { passed: typecheck.passed, detail: summarizeCommand(typecheck) },
    cliSmoke: { passed: cliSmoke.passed, detail: summarizeCommand(cliSmoke) },
  }
  const passedChecks = Object.values(checks).filter((check) => check.passed).length
  const totalChecks = Object.keys(checks).length
  return {
    acceptanceScore: passedChecks / totalChecks,
    passedChecks,
    totalChecks,
    success: passedChecks === totalChecks,
    checks,
    targetedTest,
    typecheck,
    cliSmoke,
    hiddenContract,
  }
}

async function runHiddenContract(workspace: string, sourceExists: boolean): Promise<Check> {
  if (!sourceExists) return { passed: false, detail: 'hidden contract skipped because the engine source is missing' }
  const sourceName = await findSourceName(workspace, 'game')
  if (!sourceName) return { passed: false, detail: 'engine module could not be located' }
  try {
    const imported = await import(pathToFileURL(join(workspace, 'games', 'tic-tac-toe', 'src', sourceName)).href) as GameModule
    const aiSourceName = await findSourceName(workspace, 'ai')
    const aiModule = aiSourceName
      ? await import(pathToFileURL(join(workspace, 'games', 'tic-tac-toe', 'src', aiSourceName)).href) as GameModule
      : {}
    const { createGame, makeMove, availableMoves, getWinner } = imported
    const chooseMove = imported.chooseMove ?? imported.getBestMove ?? imported.findBestMove ?? aiModule.chooseMove ?? aiModule.getBestMove ?? aiModule.findBestMove
    if (!createGame || !makeMove || !availableMoves || !getWinner) throw new Error('required engine behavior could not be located')
    if (!chooseMove) {
      const aiSourceName = await findSourceName(workspace, 'ai')
      const aiSource = aiSourceName
        ? await readFile(join(workspace, 'games', 'tic-tac-toe', 'src', aiSourceName), 'utf8')
        : ''
      if (!/minimax|bestMove|chooseMove/i.test(aiSource)) throw new Error('AI strategy could not be located')
    }
    const initial = createGame()
    assert.deepEqual(initial.board, [null, null, null, null, null, null, null, null, null])
    assert.equal(initial.currentPlayer, 'X')
    assert.equal(normalizeStatus(initial.status), 'playing')
    assert.equal(initial.winner ?? null, null)
    assert.equal(moveCount(initial), 0)
    assert.deepEqual(availableMoves(initial.board), [0, 1, 2, 3, 4, 5, 6, 7, 8])

    const first = requireMove(makeMove(initial, 0), 'first move')
    assert.equal(first.currentPlayer, 'O')
    assert.equal(first.board[0], 'X')
    assert.equal(moveCount(first), 1)
    const occupied = makeMove(first, 0)
    assertRejected(occupied, first, 'occupied move')
    const outOfRange = makeMove(first, 9)
    assertRejected(outOfRange, first, 'out-of-range move')

    const rowWin = playSequence({ createGame, makeMove }, [0, 3, 1, 4, 2])
    assert.equal(normalizeStatus(rowWin.status), 'won')
    assert.equal(rowWin.winner, 'X')
    assert.deepEqual(lineOf(rowWin, getWinner(rowWin.board)), [0, 1, 2])
    const columnWin = playSequence({ createGame, makeMove }, [0, 1, 3, 2, 6])
    assert.equal(columnWin.winner, 'X')
    assert.deepEqual(lineOf(columnWin, getWinner(columnWin.board)), [0, 3, 6])
    const diagonalWin = playSequence({ createGame, makeMove }, [0, 1, 4, 2, 8])
    assert.equal(diagonalWin.winner, 'X')
    assert.deepEqual(lineOf(diagonalWin, getWinner(diagonalWin.board)), [0, 4, 8])
    const draw = playSequence({ createGame, makeMove }, [0, 1, 2, 4, 3, 5, 7, 6, 8])
    assert.equal(normalizeStatus(draw.status), 'draw')
    assert.equal(draw.winner ?? null, null)
    assert.equal(availableMoves(draw.board).length, 0)
    const postGame = makeMove(rowWin, 5)
    assertRejected(postGame, rowWin, 'post-game move')

    if (chooseMove) {
      const threat = playSequence({ createGame, makeMove }, [0, 3, 1, 4])
      assert.equal(chooseMove(threat, 'perfect'), 2)
    }
    assert.equal(winnerOf(getWinner(rowWin.board)), 'X')
    return { passed: true, detail: 'engine behavior, win/draw cases, immutability, and AI threat response passed' }
  } catch (error) {
    return { passed: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

async function findSourceName(workspace: string, stem: string): Promise<string | undefined> {
  for (const extension of ['ts', 'js', 'mjs', 'cjs']) {
    const candidate = `${stem}.${extension}`
    try {
      await access(join(workspace, 'games', 'tic-tac-toe', 'src', candidate))
      return candidate
    } catch {
      // Try the next supported module extension.
    }
  }
  return undefined
}

function playSequence(api: { createGame: (startingPlayer?: Mark) => LooseState; makeMove: (state: LooseState, index: number) => LooseState | MoveResult }, moves: number[]): LooseState {
  let state = api.createGame()
  for (const move of moves) state = requireMove(api.makeMove(state, move), `move ${move + 1}`)
  return state
}

function requireMove(result: LooseState | MoveResult, label: string): LooseState {
  if (isMoveResult(result)) {
    if (!result.ok) throw new Error(`${label} rejected: ${result.error}`)
    return result.state
  }
  return result
}

function assertRejected(result: LooseState | MoveResult, original: LooseState, label: string): void {
  if (isMoveResult(result)) {
    assert.equal(result.ok, false, `${label} should be rejected`)
    assert.deepEqual(result.state, original)
  } else {
    assert.strictEqual(result, original, `${label} should preserve the original state`)
  }
}

function isMoveResult(value: LooseState | MoveResult): value is MoveResult {
  return 'ok' in value
}

function normalizeStatus(status: string): string {
  return status.toLowerCase()
}

function moveCount(state: LooseState): number {
  return state.moves ?? state.moveCount ?? 0
}

type WinnerResult = Mark | null | { winner: Mark | null; line?: readonly number[] | null; winningLine?: readonly number[] | null }

function winnerOf(result: WinnerResult): Mark | null {
  return typeof result === 'object' && result !== null ? result.winner : result
}

function lineOf(state: LooseState, result: WinnerResult): readonly number[] | null {
  return state.winningLine ?? (typeof result === 'object' && result !== null ? result.line ?? result.winningLine ?? null : null)
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const relativePath = join(prefix, entry.name)
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'target' || entry.name === 'dist') continue
    if (entry.isDirectory()) files.push(...await listFiles(root, relativePath))
    else if (entry.isFile()) files.push(relativePath)
  }
  return files
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

async function runCommand(command: string, args: string[], cwd: string, timeout: number): Promise<CommandResult> {
  const started = performance.now()
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env: { ...process.env, CI: '1', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' },
      timeout,
      maxBuffer: 300_000,
    })
    return {
      passed: true,
      code: 0,
      durationMs: Math.round(performance.now() - started),
      stdout: result.stdout,
      stderr: result.stderr,
    }
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string; killed?: boolean }
    return {
      passed: false,
      code: failure.code ?? 1,
      durationMs: Math.round(performance.now() - started),
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? failure.message,
      ...(failure.killed ? { timedOut: true } : {}),
    }
  }
}

function failedCommand(detail: string): CommandResult {
  return { passed: false, code: 'missing', durationMs: 0, stdout: '', stderr: detail }
}

function summarizeCommand(result: CommandResult): string {
  if (result.passed) return `passed in ${result.durationMs} ms`
  const detail = `${result.stderr}\n${result.stdout}`.trim().replace(/\s+/g, ' ').slice(0, 220)
  return `failed (${detail || `exit ${result.code}`})`
}

function parseModel(value: string | undefined): ModelRef | undefined {
  if (!value) return undefined
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) throw new Error('CUPPET_AB_MODEL must be provider/model')
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
}

function parseArms(value: string | undefined): [Arm, Arm] | undefined {
  if (!value) return undefined
  const arms = value.split(',').map((arm) => arm.trim())
  if (arms.length !== 2 || arms[0] === arms[1] || arms.some((arm) => !['opencode', 'cuppet', 'deepseek-harness'].includes(arm))) {
    throw new Error('CUPPET_TTT_ARMS must contain two distinct arms from opencode,cuppet,deepseek-harness')
  }
  return arms as [Arm, Arm]
}

async function waitForIndex(runtime: TstRuntime): Promise<void> {
  const deadline = Date.now() + 3 * 60_000
  while (Date.now() < deadline) {
    const status = await runtime.client.call<{ graph?: { progress?: { complete?: boolean; indexed?: number; discovered?: number } } }>('status')
    const progress = status.graph?.progress
    if (progress?.complete) return
    process.stdout.write(`Indexing ${progress?.indexed ?? 0}/${progress?.discovered ?? '?'}\r`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  throw new Error('Timed out waiting for the code graph index')
}

function assistantText(messages: unknown[]): string {
  const output: string[] = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const record = message as { info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }
    if (record.info?.role !== 'assistant') continue
    for (const part of record.parts ?? []) if (part.type === 'text' && part.text) output.push(part.text)
  }
  return output.join('\n').trim()
}

function summarize(values: Trial[]) {
  const armSummary = (arm: Arm) => {
    const selected = values.filter((trial) => trial.arm === arm)
    const successful = selected.filter((trial) => trial.success)
    return {
      trials: selected.length,
      successes: successful.length,
      completionRate: ratio(successful.length, selected.length),
      meanAcceptanceScore: mean(selected.map((trial) => trial.acceptanceScore)),
      medianLatencyMs: median(selected.map((trial) => trial.durationMs)),
      medianUncachedInputTokens: median(selected.map((trial) => trial.uncachedInputTokens)),
      medianTotalModelTokens: median(selected.map((trial) => trial.totalModelTokens)),
      medianCost: median(selected.map((trial) => trial.cost)),
      totalCost: selected.reduce((sum, trial) => sum + trial.cost, 0),
      meanToolCalls: mean(selected.map((trial) => trial.toolCalls)),
      meanPermissionRequests: mean(selected.map((trial) => trial.permissionRequests)),
      medianContextTokens: median(selected.map((trial) => trial.contextTokens)),
      costPerAcceptancePoint: ratio(sum(selected.map((trial) => trial.cost)), sum(selected.map((trial) => trial.acceptanceScore))),
      uncachedTokensPerAcceptancePoint: ratio(sum(selected.map((trial) => trial.uncachedInputTokens)), sum(selected.map((trial) => trial.acceptanceScore))),
    }
  }
  const opencode = armSummary('opencode')
  const cuppet = armSummary('cuppet')
  return {
    opencode,
    cuppet,
    comparison: {
      completionRateDelta: cuppet.completionRate - opencode.completionRate,
      acceptanceScoreDelta: cuppet.meanAcceptanceScore - opencode.meanAcceptanceScore,
      latencyReduction: ratio(opencode.medianLatencyMs - cuppet.medianLatencyMs, opencode.medianLatencyMs),
      costReduction: ratio(opencode.medianCost - cuppet.medianCost, opencode.medianCost),
      totalCostDelta: cuppet.totalCost - opencode.totalCost,
      uncachedInputReduction: ratio(opencode.medianUncachedInputTokens - cuppet.medianUncachedInputTokens, opencode.medianUncachedInputTokens),
      totalModelTokenReduction: ratio(opencode.medianTotalModelTokens - cuppet.medianTotalModelTokens, opencode.medianTotalModelTokens),
      costPerAcceptancePointReduction: ratio(opencode.costPerAcceptancePoint - cuppet.costPerAcceptancePoint, opencode.costPerAcceptancePoint),
    },
  }
}

function summarizePair(values: Trial[], baselineArm: Arm, candidateArm: Arm) {
  const armSummary = (arm: Arm) => {
    const selected = values.filter((trial) => trial.arm === arm)
    const successful = selected.filter((trial) => trial.success)
    return {
      trials: selected.length,
      successes: successful.length,
      completionRate: ratio(successful.length, selected.length),
      meanAcceptanceScore: mean(selected.map((trial) => trial.acceptanceScore)),
      medianLatencyMs: median(selected.map((trial) => trial.durationMs)),
      medianUncachedInputTokens: median(selected.map((trial) => trial.uncachedInputTokens)),
      medianTotalModelTokens: median(selected.map((trial) => trial.totalModelTokens)),
      medianModelCalls: median(selected.map((trial) => trial.modelCalls)),
      medianCacheReadTokens: median(selected.map((trial) => trial.cacheReadTokens)),
      medianCacheWriteTokens: median(selected.map((trial) => trial.cacheWriteTokens)),
      meanToolCalls: mean(selected.map((trial) => trial.toolCalls)),
      medianContextTokens: median(selected.map((trial) => trial.contextTokens)),
    }
  }
  const baseline = armSummary(baselineArm)
  const candidate = armSummary(candidateArm)
  return {
    baselineArm,
    candidateArm,
    baseline,
    candidate,
    comparison: {
      completionRateDelta: candidate.completionRate - baseline.completionRate,
      acceptanceScoreDelta: candidate.meanAcceptanceScore - baseline.meanAcceptanceScore,
      latencyReduction: ratio(baseline.medianLatencyMs - candidate.medianLatencyMs, baseline.medianLatencyMs),
      uncachedInputReduction: ratio(baseline.medianUncachedInputTokens - candidate.medianUncachedInputTokens, baseline.medianUncachedInputTokens),
      totalModelTokenReduction: ratio(baseline.medianTotalModelTokens - candidate.medianTotalModelTokens, baseline.medianTotalModelTokens),
      cacheReadReduction: ratio(baseline.medianCacheReadTokens - candidate.medianCacheReadTokens, baseline.medianCacheReadTokens),
    },
  }
}

function renderMarkdown(report: { createdAt: string; model: ModelRef; repeats: number; summary: ReturnType<typeof summarize>; trials: Trial[] }): string {
  const { opencode, cuppet, comparison } = report.summary
  const money = (value: number) => `$${value.toFixed(6)}`
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`
  const rows = [
    ['Successful trials', `${opencode.successes}/${opencode.trials}`, `${cuppet.successes}/${cuppet.trials}`, percent(comparison.completionRateDelta)],
    ['Mean acceptance score', percent(opencode.meanAcceptanceScore), percent(cuppet.meanAcceptanceScore), percent(comparison.acceptanceScoreDelta)],
    ['Median latency', `${opencode.medianLatencyMs} ms`, `${cuppet.medianLatencyMs} ms`, percent(comparison.latencyReduction) + ' reduction'],
    ['Median uncached input', `${opencode.medianUncachedInputTokens}`, `${cuppet.medianUncachedInputTokens}`, percent(comparison.uncachedInputReduction) + ' reduction'],
    ['Median total model tokens', `${opencode.medianTotalModelTokens}`, `${cuppet.medianTotalModelTokens}`, percent(comparison.totalModelTokenReduction) + ' reduction'],
    ['Median cost', money(opencode.medianCost), money(cuppet.medianCost), percent(comparison.costReduction) + ' reduction'],
    ['Total cost', money(opencode.totalCost), money(cuppet.totalCost), money(comparison.totalCostDelta)],
    ['Cost / acceptance point', money(opencode.costPerAcceptancePoint), money(cuppet.costPerAcceptancePoint), percent(comparison.costPerAcceptancePointReduction) + ' reduction'],
    ['Mean tool calls', opencode.meanToolCalls.toFixed(1), cuppet.meanToolCalls.toFixed(1), 'lower is more efficient'],
    ['Median injected context', `${opencode.medianContextTokens}`, `${cuppet.medianContextTokens}`, 'Cuppet retrieval overhead'],
  ]
  return [
    '# Tic-Tac-Toe coding A/B evaluation',
    '',
    `- Created: ${report.createdAt}`,
    `- Model: \`${report.model.providerID}/${report.model.modelID}\``,
    `- Paired repeats: ${report.repeats}`,
    '- Baseline A: OpenCode kernel session with the original task prompt.',
    '- Candidate B: Cuppet session with the same task plus bounded TST context.',
    '- Every trial used a fresh isolated copy; edits and validation commands were permitted only inside that copy.',
    '',
    '| Metric | OpenCode | Cuppet | Cuppet vs OpenCode |',
    '|---|---:|---:|---:|',
    ...rows.map((row) => `| ${row[0]} | ${row[1]} | ${row[2]} | ${row[3]} |`),
    '',
    '## Trial acceptance details',
    '',
    ...report.trials.map((trial) => {
      const checks = Object.entries(trial.evaluation.checks).map(([name, check]) => `${check.passed ? '✓' : '✗'} ${name}`).join(', ')
      return `- Repeat ${trial.repeat}, ${trial.arm}: ${trial.success ? 'success' : 'incomplete'}; score ${(trial.acceptanceScore * 100).toFixed(1)}%; ${checks}`
    }),
    '',
    'Interpretation: this is a small paired coding benchmark. Treat deltas as directional until more independent repeats and tasks are collected.',
    '',
  ].join('\n')
}

function renderPairMarkdown(report: { createdAt: string; model: ModelRef; repeats: number; summary: ReturnType<typeof summarizePair>; trials: Trial[] }): string {
  const { baseline, candidate, comparison, baselineArm, candidateArm } = report.summary
  const percent = (value: number) => `${(value * 100).toFixed(1)}%`
  const rows = [
    ['Successful trials', `${baseline.successes}/${baseline.trials}`, `${candidate.successes}/${candidate.trials}`, percent(comparison.completionRateDelta)],
    ['Mean acceptance score', percent(baseline.meanAcceptanceScore), percent(candidate.meanAcceptanceScore), percent(comparison.acceptanceScoreDelta)],
    ['Median latency', `${baseline.medianLatencyMs} ms`, `${candidate.medianLatencyMs} ms`, `${percent(comparison.latencyReduction)} reduction`],
    ['Median uncached input', `${baseline.medianUncachedInputTokens}`, `${candidate.medianUncachedInputTokens}`, `${percent(comparison.uncachedInputReduction)} reduction`],
    ['Median total model tokens', `${baseline.medianTotalModelTokens}`, `${candidate.medianTotalModelTokens}`, `${percent(comparison.totalModelTokenReduction)} reduction`],
    ['Median cache-read tokens', `${baseline.medianCacheReadTokens}`, `${candidate.medianCacheReadTokens}`, `${percent(comparison.cacheReadReduction)} reduction`],
    ['Median model calls', `${baseline.medianModelCalls}`, `${candidate.medianModelCalls}`, 'lower is more efficient'],
    ['Mean tool calls', baseline.meanToolCalls.toFixed(1), candidate.meanToolCalls.toFixed(1), 'lower is more efficient'],
    ['Median injected context', `${baseline.medianContextTokens}`, `${candidate.medianContextTokens}`, 'Cuppet retrieval overhead'],
  ]
  return [
    '# Tic-Tac-Toe coding benchmark',
    '',
    `- Created: ${report.createdAt}`,
    `- Model: \`${report.model.providerID}/${report.model.modelID}\``,
    `- Paired repeats: ${report.repeats}`,
    `- Baseline: ${baselineArm}.`,
    `- Candidate: ${candidateArm}.`,
    '- Every trial used a fresh isolated repository copy and the same task prompt.',
    '- Input tokens are the uncached prompt tokens reported by each runtime; cache-read tokens are reported separately.',
    '',
    `| Metric | ${baselineArm} | ${candidateArm} | Candidate vs baseline |`,
    '|---|---:|---:|---:|',
    ...rows.map((row) => `| ${row[0]} | ${row[1]} | ${row[2]} | ${row[3]} |`),
    '',
    '## Trial acceptance details',
    '',
    ...report.trials.map((trial) => {
      const checks = Object.entries(trial.evaluation.checks).map(([name, check]) => `${check.passed ? '✓' : '✗'} ${name}`).join(', ')
      return `- Repeat ${trial.repeat}, ${trial.arm}: ${trial.success ? 'success' : 'incomplete'}; score ${(trial.acceptanceScore * 100).toFixed(1)}%; uncached input ${trial.uncachedInputTokens}; ${checks}`
    }),
    '',
    'Interpretation: task-specific paired evidence; consider token deltas together with acceptance outcomes and repeat count.',
    '',
  ].join('\n')
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle] ?? 0
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
