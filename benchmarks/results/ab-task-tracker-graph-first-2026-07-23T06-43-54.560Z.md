# Task Tracker graph-first instruction experiment

- Created: 2026-07-23T06:43:54.560Z
- Model: `google-vertex/gemini-flash-latest`
- Repeats per arm: 3
- Two fresh-workspace arms used the same fixture, model, tools, permissions, existing bounded `CUPPET_CONTEXT`, hidden evaluator, and official OpenCode kernel.
- External-directory discovery was allowed for every arm with `CUPPET_TTT_ALLOW_EXTERNAL=1`.
- The graph-first instruction required `cuppet_memory_search` as the first tool call and encouraged follow-up graph queries before workspace inspection. The harness recorded violations without rejecting the call.

## Arms

- **current**: current Cuppet instruction plus the existing bounded TST context.
- **graph-first**: graph-navigation instruction plus the identical existing bounded TST context.

## Results

| Arm | Successes | Mean acceptance | Hop≤1 | Hop2 | Median latency | Successful latency | Successful cost | Successful tokens | Context tokens | Instruction applied | First tool graph | Graph before workspace | Mean graph calls | First graph | First workspace |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 2/3 | 87.5% | 66.7% | 66.7% | 199218 ms | 217292.5 ms | $0.337152 | 77578.5 | 1260 | 100.0% | 0.0% | 0.0% | 0.0 | — | 7347.5 ms |
| graph-first | 3/3 | 100.0% | 100.0% | 100.0% | 201650 ms | 201650 ms | $0.336432 | 81074 | 1260 | 100.0% | 0.0% | 0.0% | 0.0 | — | 8429 ms |

Successful-only latency, token, and cost metrics are primary efficiency measures; all-trial medians retain the cost of early incomplete sessions.

## Graph-tool adoption

- Effective instruction preflight: 6/6 trials (100.0%).
- `cuppet_memory_search` first-tool compliance: 0/3 graph-first trials.
- Total `cuppet_memory_search` calls: 0 in both arms.
- First graph-first tools: `grep`, `glob`, and `glob`.

The graph-first arm's higher acceptance therefore cannot be credited to graph
retrieval. It reflects the instruction-conditioned run, but the model did not
invoke the graph tool itself. This is evidence about tool adoption under this
model/kernel combination, not evidence that the graph's returned data is
useless.

## Controlled instruction effect

| Comparison | Completion Δ | Acceptance Δ | Successful latency reduction | Successful cost reduction | Successful token reduction | Hop≤1 Δ | Hop2 Δ |
|---|---:|---:|---:|---:|---:|---:|---:|
| graph-first vs current | 33.3% | 12.5% | 7.2% | 0.2% | -4.5% | 33.3% | 33.3% |

## Trial details

- Repeat 1, **current**: incomplete; acceptance 62.5%; latency 20901 ms; instruction applied yes; first tool `todowrite` (violation); graph calls 0; graph before workspace no; first graph —; first workspace —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 1, **graph-first**: success; acceptance 100.0%; latency 201650 ms; instruction applied yes; first tool `grep` (violation); graph calls 0; graph before workspace no; first graph —; first workspace 8835 ms.
- Repeat 2, **graph-first**: success; acceptance 100.0%; latency 180998 ms; instruction applied yes; first tool `glob` (violation); graph calls 0; graph before workspace no; first graph —; first workspace 6197 ms.
- Repeat 2, **current**: success; acceptance 100.0%; latency 199218 ms; instruction applied yes; first tool `grep` (violation); graph calls 0; graph before workspace no; first graph —; first workspace 7878 ms.
- Repeat 3, **current**: success; acceptance 100.0%; latency 235367 ms; instruction applied yes; first tool `glob` (violation); graph calls 0; graph before workspace no; first graph —; first workspace 6817 ms.
- Repeat 3, **graph-first**: success; acceptance 100.0%; latency 217780 ms; instruction applied yes; first tool `glob` (violation); graph calls 0; graph before workspace no; first graph —; first workspace 8429 ms.

Interpretation must remain task-specific. This isolates instruction wording while holding the existing context constant. 3 repeats per arm provide directional evidence, not a product-wide statistical claim.
