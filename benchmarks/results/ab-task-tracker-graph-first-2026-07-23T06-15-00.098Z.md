# Task Tracker graph-first instruction experiment

- Created: 2026-07-23T06:15:00.098Z
- Model: `google-vertex/gemini-flash-latest`
- Repeats per arm: 3
- Two fresh-workspace arms used the same fixture, model, tools, permissions, existing bounded `CUPPET_CONTEXT`, hidden evaluator, and official OpenCode kernel.
- External-directory discovery was allowed for every arm with `CUPPET_TTT_ALLOW_EXTERNAL=1`.
- The graph-first instruction required `cuppet_memory_search` as the first tool call and encouraged follow-up graph queries before workspace inspection. The harness recorded violations without rejecting the call.

> Validity note: this run is diagnostic-only for instruction delivery. Post-run inspection of the retained OpenCode agent log showed that the graph-first override was not present in the effective foreground agent system; all six trials therefore ran with the plugin's fixed default system prompt. The recorded zero graph calls must not be interpreted as the model rejecting the graph-first instruction. The harness was corrected afterward to pass the override through the plugin and preflight the effective instruction before any model call.

## Arms

- **current**: current Cuppet instruction plus the existing bounded TST context.
- **graph-first**: graph-navigation instruction plus the identical existing bounded TST context.

## Results

| Arm | Successes | Mean acceptance | Hop≤1 | Hop2 | Median latency | Successful latency | Successful cost | Successful tokens | Context tokens | First tool graph | Graph before workspace | Mean graph calls | First graph | First workspace |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 1/3 | 66.7% | 33.3% | 33.3% | 41352 ms | 209281 ms | $0.319098 | 75018 | 1260 | 0.0% | 0.0% | 0.0 | — | 6937.5 ms |
| graph-first | 1/3 | 75.0% | 33.3% | 33.3% | 41042 ms | 194764 ms | $0.308964 | 78527 | 1260 | 0.0% | 0.0% | 0.0 | — | 7627 ms |

Successful-only latency, token, and cost metrics are primary efficiency measures; all-trial medians retain the cost of early incomplete sessions.

## Controlled instruction effect

| Comparison | Completion Δ | Acceptance Δ | Successful latency reduction | Successful cost reduction | Successful token reduction | Hop≤1 Δ | Hop2 Δ |
|---|---:|---:|---:|---:|---:|---:|---:|
| graph-first vs current | 0.0% | 8.3% | 6.9% | 3.2% | -4.7% | 0.0% | 0.0% |

## Trial details

- Repeat 1, **current**: success; acceptance 100.0%; latency 209281 ms; first tool `grep` (violation); graph calls 0; graph before workspace no; first graph —; first workspace 7109 ms.
- Repeat 1, **graph-first**: success; acceptance 100.0%; latency 194764 ms; first tool `grep` (violation); graph calls 0; graph before workspace no; first graph —; first workspace 6764 ms.
- Repeat 2, **graph-first**: incomplete; acceptance 62.5%; latency 20229 ms; first tool `glob` (violation); graph calls 0; graph before workspace no; first graph —; first workspace 8490 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 2, **current**: incomplete; acceptance 37.5%; latency 41352 ms; first tool `glob` (violation); graph calls 0; graph before workspace no; first graph —; first workspace 6766 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'
 · targetedTests: failed ([FAIL] validate rejects malformed dates AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: true !== false at <anonymous> (/private/tmp/cttr-TAMwl5/current-2/games/task-tracker/test/task-tracker.test.ts:27:10) at runTest () · typecheck: failed (> cuppet-monorepo@0.2.0-alpha.1 task-tracker:typecheck > tsc --noEmit --project games/task-tracker/tsconfig.json games/task-tracker/src/core/taskFactory.ts(11,15): error TS2339: Property 'dueDate' does not exist on type 'NewTask'. games/tas)
- Repeat 3, **current**: incomplete; acceptance 62.5%; latency 14832 ms; first tool `todowrite` (violation); graph calls 0; graph before workspace no; first graph —; first workspace —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 3, **graph-first**: incomplete; acceptance 62.5%; latency 41042 ms; first tool `todowrite` (violation); graph calls 0; graph before workspace no; first graph —; first workspace —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'


Interpretation must remain task-specific. This isolates instruction wording while holding the existing context constant. 3 repeats per arm provide directional evidence, not a product-wide statistical claim.
