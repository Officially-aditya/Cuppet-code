# Task Tracker enforced graph-first experiment

- Created: 2026-07-23T07:03:48.929Z
- Model: `google-vertex/gemini-flash-latest`
- Repeats per arm: 2
- Two fresh-workspace arms used the same fixture, model, tools, existing bounded `CUPPET_CONTEXT`, hidden evaluator, and official OpenCode kernel.
- External-directory discovery was allowed for every arm with `CUPPET_TTT_ALLOW_EXTERNAL=1`.
- The graph-first arm enforced `cuppet_memory_search` before non-graph tool execution: pre-graph non-graph permission requests were denied by the harness, then normal tools were allowed after the first graph search. Expected gate denials are reported separately from unexpected permission failures.

## Arms

- **current**: current Cuppet instruction plus the existing bounded TST context.
- **graph-first**: graph-navigation instruction plus the identical existing bounded TST context.

## Results

| Arm | Successes | Mean acceptance | Hop≤1 | Hop2 | Median latency | Successful latency | Successful cost | Successful tokens | Context tokens | Instruction applied | Gate denials | Unexpected rejects | First tool graph | Graph before workspace | Mean graph calls | First graph | First workspace |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 0/2 | 62.5% | 0.0% | 0.0% | 21787 ms | 0 ms | $0.000000 | 0 | 1260 | 100.0% | 0 | 0 | 0.0% | 0.0% | 0.0 | — | 8380 ms |
| graph-first | 0/2 | 62.5% | 0.0% | 0.0% | 10143 ms | 0 ms | $0.000000 | 0 | 1260 | 100.0% | 2 | 0 | 0.0% | 0.0% | 0.0 | — | 7061 ms |

Successful-only latency, token, and cost metrics are primary efficiency measures; all-trial medians retain the cost of early incomplete sessions.

## Controlled instruction effect

| Comparison | Completion Δ | Acceptance Δ | Successful latency reduction | Successful cost reduction | Successful token reduction | Hop≤1 Δ | Hop2 Δ |
|---|---:|---:|---:|---:|---:|---:|---:|
| graph-first vs current | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |

## Trial details

- Repeat 1, **current**: incomplete; acceptance 62.5%; latency 24128 ms; instruction applied yes; first tool `todowrite` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; first graph —; first workspace 9035 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 1, **graph-first**: incomplete; acceptance 62.5%; latency 10865 ms; instruction applied yes; first tool `grep` (violation); graph calls 0; graph before workspace no; gate denials 1; unexpected rejects 0; first graph —; first workspace 7764 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 2, **graph-first**: incomplete; acceptance 62.5%; latency 9421 ms; instruction applied yes; first tool `grep` (violation); graph calls 0; graph before workspace no; gate denials 1; unexpected rejects 0; first graph —; first workspace 6358 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 2, **current**: incomplete; acceptance 62.5%; latency 19446 ms; instruction applied yes; first tool `todowrite` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; first graph —; first workspace 7725 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'


Interpretation must remain task-specific. Because the graph-first arm includes an enforced pre-graph gate, this measures a graph-assisted workflow rather than instruction wording alone. 2 repeats per arm provide directional evidence, not a product-wide statistical claim.
