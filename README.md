# Cuppet public alpha

Cuppet is an Ink terminal coding-agent supervisor backed by a pinned OpenCode
server and a native Rust tiered-memory/code-graph daemon.

The alpha pins OpenCode and `@opencode-ai/sdk` to the stable **v1.18.4** release
at revision `49c69c5ed3ccf706b61b3febb43c8aaff7f8325e`. Provider credentials, tools,
sessions, model routing, diffs, permissions, compaction, and undo stay inside
OpenCode. Cuppet stores only non-secret UI/model selections and verified
memory records.

## Requirements

- Node.js 22 or newer
- Rust 1.82 or newer for source builds
- macOS 13+ or Ubuntu 22.04+ on arm64/x64
- The pinned OpenCode binary (a release package includes it; source builds can
  set `CUPPET_OPENCODE_BIN`)

## Develop

```sh
npm ci
npm run build
npm test
CUPPET_OPENCODE_BIN=/path/to/opencode npm run dev
```

The Rust daemon is discovered at `target/debug/tst-daemon` during development.
Run `cuppet --doctor` for checksum, protocol, storage, provider, and graph
diagnostics. Cuppet starts in visible OpenCode-only degraded mode if TST is not
available, but it stops the agent loop when OpenCode itself cannot start.

For a source checkout with a locally packaged runtime, run
`npm run install:global`. The installer packs the runtime and CLI before
installing them, so the global commands never symlink back into the checkout
(which macOS may block when the repository is under `Downloads`). Typing
`cupet` then launches Cuppet from any directory; `cuppet` remains available as
the canonical command. The standard `cc` C compiler is never shadowed.

On first launch, Cuppet asks for a platform before showing models. Choose
Anthropic, OpenAI, Google (Gemini API), Vertex AI (Google Cloud ADC), or
OpenCode; if needed, the matching OpenCode authentication flow appears before
the live model picker. Vertex detects either `GOOGLE_APPLICATION_CREDENTIALS`
or standard gcloud application-default credentials. When neither is present,
run `gcloud auth application-default login`, set `GOOGLE_CLOUD_PROJECT` (or
`GOOGLE_VERTEX_PROJECT`), and restart Cuppet. Cuppet passes
`GOOGLE_VERTEX_LOCATION=global` by default; `GOOGLE_VERTEX_LOCATION` or
`GOOGLE_CLOUD_LOCATION` can override it. Provider connections coexist: `/platform` filters the model picker;
it does not disconnect other providers. The platform and model choices contain
no credentials and are remembered. Run `/platform` to repeat this selection
later.

## Architecture

```text
Ink UI + Cuppet supervisor
  ├─ OpenCode 1.18.4 + SDK catalog/auth/session APIs + SSE
  │  └─ sessions, tools, permissions, models, diffs, auth, undo
  └─ tst-daemon (framed JSON-RPC 2.0 over a private Unix socket)
     └─ session STM, verified project/global LTM, Tree-sitter graph, WAL
```

Project stores live at `~/.cuppet/v2/projects/<sha256(realpath)>`. Runtime
sockets use a mode-0700 launch directory and mode-0600 socket. OpenCode is
given isolated XDG config/data/cache/state directories below
`~/.cuppet/v2/opencode`; Cuppet never parses its credential records.

Cuppet uses OpenCode's v2 APIs for the live catalog and agent registration and
the same bundled server's stable session/provider API for turns. This preserves
the mature Google Vertex, Azure, Gemini, Anthropic, and OpenAI adapters while
OpenCode's v2 runner supports a smaller adapter set. No provider SDK or
credential store is implemented in Cuppet.

## OpenCode vs Cuppet coding benchmark

The repository includes a tool-driven A/B benchmark for comparing the official
OpenCode kernel with Cuppet on a small but complete software-building task. The
goal was to measure efficiency without hand-building the task in the benchmark
runner: both agents were asked to create Tic-Tac-Toe from scratch, including
the engine, AI, CLI, tests, and project scripts.

### Benchmark design

- Baseline A was an OpenCode 1.18.4 session with the original task prompt.
- Candidate B was a Cuppet session with the same prompt plus bounded TST
  retrieval context.
- Both arms used `google-vertex/gemini-flash-latest`, fresh isolated copies of
  the repository, alternating arm order, and the same local tool permissions.
- Agents had to read and search before editing, then use edits/writes and local
  shell validation. Network access and unrelated-project changes were not part
  of the task.
- The run contained three paired repeats. Latency was measured from prompt
  submission through session completion, excluding repository clone and graph
  indexing. Cost and token counts came from the OpenCode session records;
  `tokens.input` is reported as uncached input.

The task required:

- A pure TypeScript engine exporting `createGame`, `makeMove`,
  `availableMoves`, and `getWinner`.
- Legal and illegal move handling, win detection in every direction, draw
  detection, immutable/post-game behavior, and move-count state.
- An AI that wins immediately when possible, blocks immediate losses, and uses
  a perfect/minimax strategy.
- A terminal CLI with readable board rendering, input validation, quit/help
  commands, and `--help` behavior that does not wait for stdin.
- Focused tests plus root `game:test`, `game:typecheck`, and `game:play`
  scripts.

Each trial received nine acceptance checks: engine source, CLI source, test
source, npm scripts, engine signals, a hidden behavior contract, focused test
execution, TypeScript typecheck, and CLI `--help` smoke testing. A trial is
considered successful only when all checks pass and the agent session reports no
error.

### Results

| Metric | OpenCode | Cuppet | Cuppet vs OpenCode |
|---|---:|---:|---:|
| Successful trials | 2/3 (66.7%) | 2/3 (66.7%) | no change |
| Mean acceptance score | 96.3% | 92.6% | -3.7 percentage points |
| Median latency | 166,458 ms | 43,881 ms | 73.6% lower |
| Median uncached input | 68,265 tokens | 36,963 tokens | 45.9% lower |
| Median total model tokens | 91,047 | 39,332 | 56.8% lower |
| Median session cost | $0.368076 | $0.085621 | 76.7% lower |
| Total cost across three trials | $1.775203 | $0.780667 | $0.994536 lower |
| Cost per acceptance point | $0.614493 | $0.281040 | 54.3% lower |
| Mean tool calls | 29.0 | 18.3 | 36.8% fewer |
| Median injected context | 0 | 1,236 tokens | Cuppet retrieval overhead |

The result is clear for this task: Cuppet used substantially less time, model
context, tool activity, and money while achieving the same 2/3 full-trial
completion rate. The tradeoff was a 3.7-point lower mean acceptance score. One
OpenCode trial missed the hidden contract; one Cuppet trial missed the hidden
contract and focused tests. The other four trials passed every acceptance check.

This is evidence of a strong efficiency advantage on this workload, not a
general performance claim. The sample is three repeats of one task, one model,
one provider, and one repository state. More tasks, models, providers, and
repeated runs are needed for confidence intervals or a product-wide claim.

### Reproduce the benchmark

Run the same three-repeat comparison with:

```sh
CUPPET_TTT_REPEATS=3 \
CUPPET_TTT_ALLOW_EXTERNAL=1 \
npm run eval:ab:tic-tac-toe
```

`CUPPET_TTT_ALLOW_EXTERNAL=1` permits the explicit external-directory
permission required by some OpenCode discovery steps; review that permission
before enabling it. Other controls include `CUPPET_AB_MODEL` for model
selection, `CUPPET_TTT_KEEP_WORKSPACES=1` to retain trial copies, and
`CUPPET_TTT_REPEATS=1..5` to change the number of pairs. The executable harness
is [`scripts/ab-tictactoe.ts`](scripts/ab-tictactoe.ts), and the benchmark
method notes are in [`benchmarks/README.md`](benchmarks/README.md).

### Benchmark artifacts and local validation

The generated game artifact is available at
[`games/tic-tac-toe/`](games/tic-tac-toe/). The latest machine-readable report
is [`ab-tic-tac-toe-2026-07-22T19-06-37.222Z.json`](benchmarks/results/ab-tic-tac-toe-2026-07-22T19-06-37.222Z.json),
with the readable summary in
[`ab-tic-tac-toe-2026-07-22T19-06-37.222Z.md`](benchmarks/results/ab-tic-tac-toe-2026-07-22T19-06-37.222Z.md).

The generated implementation passes the focused checks:

```sh
npm run game:test
npm run game:typecheck
npm run game:play -- --help
printf 'q\n' | npm run game:play
```

## Task Tracker refactor benchmark

Tic-Tac-Toe is a useful greenfield control, but it has little existing code to
navigate. The second fixture tests the disputed capability directly: a
cross-file rename plus a call-graph-dependent bug in a 14-file TypeScript task
tracker.

### Task shape and hidden acceptance

The seeded fixture in [`games/task-tracker/`](games/task-tracker/) contains a
`Task.dueDate` field used across core, store, API, CLI, formatting, fixtures,
and tests. The store intentionally drops the field during creation. The
observable path is:

```text
cli/commands.ts → api/routes.ts → api/handlers.ts → store/taskStore.ts
```

Each agent had to:

- Rename `dueDate` to `deadline` everywhere, including the `--deadline` CLI
  option and non-literal cross-file usage sites.
- Make `validate()` reject past deadlines while accepting future ones.
- Fix the loss at the store layer so both direct `addTask()` calls and the
  CLI-to-API-to-store path preserve the deadline.
- Keep the existing tests, typecheck, and CLI help command passing.

The hidden suite was generated outside each temporary trial workspace and
scored eight checks: fixture shape, npm scripts, rename coverage, past-date
validation, two-hop propagation, focused tests, typecheck, and CLI smoke. Hop
scores are reported separately as:

- `hop≤1`: rename coverage plus validation.
- `hop2`: direct store and CLI/API/store deadline propagation.
- `regression`: tests, typecheck, and CLI smoke.

### Five-repeat result

The authoritative run used five paired repeats of
`google-vertex/gemini-flash-latest`, alternating arm order, fresh isolated
copies, and `CUPPET_TTT_ALLOW_EXTERNAL=1` for both arms. The full report is
[`ab-task-tracker-2026-07-23T03-21-57.074Z.md`](benchmarks/results/ab-task-tracker-2026-07-23T03-21-57.074Z.md),
with raw session data in
[`ab-task-tracker-2026-07-23T03-21-57.074Z.json`](benchmarks/results/ab-task-tracker-2026-07-23T03-21-57.074Z.json).

| Metric | OpenCode | Cuppet | Cuppet vs OpenCode |
|---|---:|---:|---:|
| Successful trials | 5/5 | 2/5 | -60.0 percentage points |
| Mean acceptance | 100.0% | 72.5% | -27.5 percentage points |
| `hop≤1` acceptance | 100.0% | 50.0% | -50.0 percentage points |
| `hop2` acceptance | 100.0% | 40.0% | -60.0 percentage points |
| Regression checks | 100.0% | 80.0% | -20.0 percentage points |
| Median latency, all trials | 200.2 s | 62.4 s | 68.8% lower |
| Median uncached input, all trials | 58,334 | 26,442 | 54.7% lower |
| Median total model tokens, all trials | 72,189 | 30,523 | 57.7% lower |
| Median cost, all trials | $0.287087 | $0.090580 | 68.4% lower |
| Total cost across five trials | $1.385432 | $0.898007 | $0.487425 lower |
| Mean tool calls | 34.6 | 21.0 | 39.3% fewer |

The all-trial efficiency result is confounded by three incomplete Cuppet
sessions ending early. Conditioning on successful completions reverses the
efficiency result: OpenCode's median successful latency was 200.2 seconds vs
Cuppet's 230.4 seconds, and successful median cost was $0.287087 vs $0.362980.

The graph-sensitive conclusion is therefore negative but precise: in this
fixture, Cuppet's graph context did not produce a higher-probability solution
to the two-hop bug. OpenCode reached 100% on both hop groups; Cuppet reached
50% on hop≤1 and 40% on hop2. Cuppet still used fewer tokens and tools in the
aggregate, but that saving came with a substantial reliability loss rather than
an efficiency win on completed refactors.

This should be treated as task-specific evidence, not a general product claim.
It is one fixture, one provider/model, and five repeats. The Tic-Tac-Toe
greenfield control remains useful for the other end of the spectrum; together,
the two tasks suggest measuring both completion-conditioned efficiency and
navigation-specific acceptance rather than relying on raw median cost alone.

Reproduce it with:

```sh
CUPPET_TTT_ALLOW_EXTERNAL=1 \
CUPPET_TASK_TRACKER_REPEATS=5 \
npm run eval:ab:task-tracker
```

The executable harness is [`scripts/ab-task-tracker.ts`](scripts/ab-task-tracker.ts),
and the benchmark methodology is documented in
[`benchmarks/README.md`](benchmarks/README.md).

## Alpha limits

Windows, musl, remote daemons, cloud memory sync, vector databases, and
multi-user operation are not supported. One Cuppet process may own writable
memory for a project; it can manage multiple OpenCode sessions. Offline means
no runtime binary download, not offline provider inference.

## License

Apache-2.0. Bundled third-party notices are in `THIRD_PARTY_NOTICES.md`.
