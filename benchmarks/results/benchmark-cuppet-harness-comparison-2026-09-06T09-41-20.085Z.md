# cuppet-harness-comparison

- Status: **failed**
- Benchmark version: `issue-4.1`
- Repository SHA: `840ed751b61c04afc881a393b7836d4d2c932f61`
- Task set: `issue-4-core@2026-09-05` (12 tasks)
- Manifest SHA-256: `eb88cd976a4e449390e667f4e3f3be1fce558f12d2739c8dd871427f645a0dea`
- Repetitions: 1
- Controller: local/deterministic-node-controller (issue-4.1)

## Headline metrics

| Metric | tura-direct |
|---|---:|
| Successful tasks | 10/12 |
| Success rate (95% CI) | 83.3% (55.2%–95.3%) |
| First-attempt success | 83.3% |
| Acceptance checks | 13/15 |
| Model tokens/task (median) | 295,378 |
| Model tokens/successful task | 344,106 |
| Uncached input/task (median) | 276,363 |
| Cached input/task (median) | 1,697,920 |
| Output tokens/task (median) | 15,672 |
| Tool calls/task (median) | 21 |
| Retries | 0 |
| Compactions | 0 |
| Regressions | 0 |
| Effective cost/task (median) | unavailable |

## Uncertainty

- **tura-direct**: model tokens/task 295378 (95% mean CI 242192–331318); successful-task tokens 311178 (95% mean CI 285773–341901); wall time 82580 (95% mean CI 72629–151761).

## Parity and controller notes

- **tura-direct**: Tura 0.1.37; resolved from the installed arm at run time; config SHA-256 `43df1604057121657463dbcbbfeb6bb9b434e5db3e05281ff001b7cbc7ef18f9`.
- The controller freezes the repository SHA, task prompts, model settings, harness metadata, environment allowlist, and verifier commands before the first arm runs.
- The controller only runs deterministic verification commands; it does not rewrite prompts, coach harnesses, or make subjective correctness judgments.
- Failed tasks retain all telemetry emitted before failure. A null cost means the harness did not expose provider-adjusted pricing.
- In the default Issue #4 mixed topology, persistent Cuppet/OpenCode sequences reuse one native session; Codex and Claude Code persistent-family entries run sequential native CLI turns because their resume/session telemetry is not yet reliable enough to claim a single persistent session.
- Marathon topology: one workspace and one native session per supported arm/repeat; deterministic verification runs after every task without resetting the evolving workspace.

## Long-horizon sequence

| Arm | Sequence tasks | Total uncached input | Total cached input | Final-task cache share | Early uncached median | Late uncached median | Early cache share | Late cache share |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| tura-direct | 12 × 1 | 3,254,708 | 17,272,576 | 83.8% | 195,356 | 344,356 | 69.9% | 84.8% |

Per-task cache share and marginal uncached input remain available in the JSON report under `longHorizon[].tasks`.

## Per-task results

- Repeat 1, **tura-direct**, `task-tracker-cross-file`: failed; acceptance 75.0%; model tokens 97591; cached input 217856; uncached input 93833; tools 4; /Users/addy/Downloads/cuppet/.benchmarks/cuppet-harness-comparison-qKv57A/workspaces/marathon-repeat-1-tura-direct/games/task-tracker/src/core/taskFactory.ts:6
  if (!result.valid) throw new Error(result.errors.join('; '))
                           ^

Error: priority must be low, normal, or high
    at Module.buildTask (/Users/addy/Downloads/cuppet/.benchmarks/cuppet-harness-comparison-qKv57A/workspaces/marathon-repeat-1-tura-direct/games/task-tracker/src/core/taskFactory.ts:6:28)
    at verifyTaskTracker (/Users/addy/Downloads/cuppet/scripts/benchmark-verifier.ts:50:25)
    at async <anonymous> (/Users/addy/Downloads/cuppet/scripts/benchmark-verifier.ts:7:1)

Node.js v22.21.0.
- Repeat 1, **tura-direct**, `quiz-game-greenfield`: failed; acceptance 0.0%; model tokens 205099; cached input 436992; uncached input 195356; tools 7; node:internal/modules/run_main:123
    triggerUncaughtException(
    ^

AssertionError [ERR_ASSERTION]: quiz-game has too few local records
    at verifyWebProject (/Users/addy/Downloads/cuppet/scripts/benchmark-verifier.ts:85:10)
    at async <anonymous> (/Users/addy/Downloads/cuppet/scripts/benchmark-verifier.ts:7:1) {
  generatedMessage: false,
  code: 'ERR_ASSERTION',
  actual: false,
  expected: true,
  operator: '==',
  diff: 'simple'
}

Node.js v22.21.0.
- Repeat 1, **tura-direct**, `persistent-build-stage-1`: success; acceptance 100.0%; model tokens 252153; cached input 749312; uncached input 237872; tools 10.
- Repeat 1, **tura-direct**, `persistent-build-stage-2`: success; acceptance 100.0%; model tokens 267513; cached input 1349888; uncached input 250594; tools 17.
- Repeat 1, **tura-direct**, `persistent-build-stage-3`: success; acceptance 100.0%; model tokens 300631; cached input 1531392; uncached input 281248; tools 19.
- Repeat 1, **tura-direct**, `switch-a-auth`: success; acceptance 100.0%; model tokens 290125; cached input 1641472; uncached input 271477; tools 20.
- Repeat 1, **tura-direct**, `switch-a-followup`: success; acceptance 100.0%; model tokens 339500; cached input 1754368; uncached input 319937; tools 22.
- Repeat 1, **tura-direct**, `switch-b-auth`: success; acceptance 100.0%; model tokens 281241; cached input 1847040; uncached input 264821; tools 25.
- Repeat 1, **tura-direct**, `switch-b-followup`: success; acceptance 100.0%; model tokens 324072; cached input 1999616; uncached input 306435; tools 27.
- Repeat 1, **tura-direct**, `switch-c`: success; acceptance 100.0%; model tokens 321724; cached input 1854208; uncached input 307625; tools 28.
- Repeat 1, **tura-direct**, `switch-a-return`: success; acceptance 100.0%; model tokens 359109; cached input 1914880; uncached input 344356; tools 29.
- Repeat 1, **tura-direct**, `long-tool-use-dashboard`: success; acceptance 100.0%; model tokens 402303; cached input 1975552; uncached input 381154; tools 33.
