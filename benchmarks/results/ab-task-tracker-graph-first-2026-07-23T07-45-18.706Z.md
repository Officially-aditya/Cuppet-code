# Task Tracker enforced graph-first experiment

- Created: 2026-07-23T07:45:18.706Z
- Model: `google-vertex/gemini-flash-latest`
- Repeats per arm: 2
- Two fresh-workspace arms used the same fixture, model, tools, existing bounded `CUPPET_CONTEXT`, hidden evaluator, and official OpenCode kernel.
- External-directory discovery was allowed for every arm with `CUPPET_TTT_ALLOW_EXTERNAL=1`.
- The graph-first arm ran a mandatory model navigation preflight, requiring `cuppet_memory_search` before the task prompt. It also enforced `cuppet_memory_search` before non-graph tool execution: pre-graph non-graph permission requests were denied by the harness, then normal tools were allowed after the first graph search. Expected gate denials are reported separately from unexpected permission failures.

## Arms

- **current**: current Cuppet instruction plus the existing bounded TST context.
- **graph-first**: graph-navigation instruction plus the identical existing bounded TST context.

## Results

| Arm | Successes | Mean acceptance | Hop≤1 | Hop2 | Median latency | Successful latency | Successful cost | Successful tokens | Context tokens | Instruction applied | Preflight passed | Gate denials | Unexpected rejects | First tool graph | Graph before workspace | Mean graph calls | First graph | First workspace |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 2/2 | 100.0% | 100.0% | 100.0% | 243563.5 ms | 243563.5 ms | $0.377102 | 82623 | 1260 | 100.0% | 100.0% | 0 | 0 | 0.0% | 0.0% | 0.0 | — | 7530 ms |
| graph-first | 1/2 | 81.3% | 50.0% | 50.0% | 129599.5 ms | 212286 ms | $0.319927 | 71719 | 1260 | 100.0% | 100.0% | 0 | 0 | 100.0% | 100.0% | 1.0 | 3262.5 ms | 9902 ms |

Successful-only latency, token, and cost metrics are primary efficiency measures; all-trial medians retain the cost of early incomplete sessions.

## Controlled instruction effect

| Comparison | Completion Δ | Acceptance Δ | Successful latency reduction | Successful cost reduction | Successful token reduction | Hop≤1 Δ | Hop2 Δ |
|---|---:|---:|---:|---:|---:|---:|---:|
| graph-first vs current | -50.0% | -18.8% | 12.8% | 15.2% | 13.2% | -50.0% | -50.0% |

## Trial details

- Repeat 1, **current**: success; acceptance 100.0%; latency 254400 ms; instruction applied yes; graph preflight passed; first tool `grep` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; first graph —; first workspace 7496 ms.
- Repeat 1, **graph-first**: incomplete; acceptance 62.5%; latency 46913 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 1; graph before workspace yes; gate denials 0; unexpected rejects 0; first graph 3536 ms; first workspace 10922 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 2, **graph-first**: success; acceptance 100.0%; latency 212286 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 1; graph before workspace yes; gate denials 0; unexpected rejects 0; first graph 2989 ms; first workspace 8882 ms.
- Repeat 2, **current**: success; acceptance 100.0%; latency 232727 ms; instruction applied yes; graph preflight passed; first tool `grep` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; first graph —; first workspace 7564 ms.

Interpretation must remain task-specific. Because the graph-first arm includes an enforced pre-graph gate, this measures a graph-assisted workflow rather than instruction wording alone. 2 repeats per arm provide directional evidence, not a product-wide statistical claim.
