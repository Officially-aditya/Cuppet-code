# Task Tracker graph-only file-navigation experiment

- Created: 2026-07-23T11:25:24.545Z
- Model: `openai/gpt-5.6-luna@low`
- Repeats per arm: 5
- Two fresh-workspace arms used the same fixture, model, tools, existing bounded `CUPPET_CONTEXT`, hidden evaluator, and official OpenCode kernel.
- External-directory discovery was allowed for every arm with `CUPPET_TTT_ALLOW_EXTERNAL=1`.
- Configured OpenCode provider credentials/database and cached model catalog were copied into each disposable runtime; those copies are removed after evaluation.
- The graph-only arm ran a mandatory model graph preflight, then used a fresh task session where glob, grep, and LSP were disabled; read/edit/write remained available. Bash was permitted only for the three required validation commands. Any blocked file-search or unapproved bash requests are reported explicitly.

## Arms

- **current**: current Cuppet instruction plus the existing bounded TST context.
- **graph-only**: graph navigation plus read/edit/write access, with ordinary file-search tools disabled and the identical existing bounded TST context.

## Results

| Arm | Successes | Mean acceptance | Hop≤1 | Hop2 | Median latency | Successful latency | Successful cost | Successful tokens | Context tokens | Instruction applied | Preflight passed | Gate denials | Unexpected rejects | Blocked file search | Graph guidance messages | Blocked bash | First tool graph | Graph before workspace | Mean graph calls | First graph | First workspace |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 3/5 | 95.0% | 80.0% | 100.0% | 109548 ms | 109746 ms | $0.000000 | 47364 | 1252 | 100.0% | 100.0% | 0 | 0 | 0 | 0 | 0 | 0.0% | 0.0% | 9.0 | 10981 ms | 6404 ms |
| graph-only | 4/5 | 97.5% | 90.0% | 100.0% | 116896 ms | 114555.5 ms | $0.000000 | 67722 | 1252 | 100.0% | 100.0% | 0 | 0 | 0 | 10 | 10 | 100.0% | 100.0% | 16.2 | 4153 ms | 9047 ms |

Successful-only latency, token, and cost metrics are primary efficiency measures; all-trial medians retain the cost of early incomplete sessions.

## Controlled instruction effect

| Comparison | Completion Δ | Acceptance Δ | Successful latency reduction | Successful cost reduction | Successful token reduction | Hop≤1 Δ | Hop2 Δ |
|---|---:|---:|---:|---:|---:|---:|---:|
| graph-only vs current | 20.0% | 2.5% | -4.4% | 0.0% | -43.0% | 10.0% | 0.0% |

## Trial details

- Repeat 1, **current**: success; acceptance 100.0%; latency 109746 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 11; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph 14003 ms; first workspace 9145 ms.
- Repeat 1, **graph-only**: incomplete; acceptance 87.5%; latency 147447 ms; instruction applied yes; graph preflight passed; first tool `cuppet_graph_search` (compliant); graph calls 14; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 2; blocked bash 2; first graph 2092 ms; first workspace 7151 ms.
  - Failed: pastDeadline: priority must be low, normal, or high
- Repeat 2, **graph-only**: success; acceptance 100.0%; latency 112215 ms; instruction applied yes; graph preflight passed; first tool `cuppet_graph_search` (compliant); graph calls 19; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 2; blocked bash 2; first graph 4153 ms; first workspace 9434 ms.
- Repeat 2, **current**: success; acceptance 100.0%; latency 103923 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 7; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph 9620 ms; first workspace 4961 ms.
- Repeat 3, **current**: incomplete; acceptance 87.5%; latency 109548 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 7; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph 12066 ms; first workspace 6668 ms.
  - Failed: pastDeadline: priority must be low, normal, or high
- Repeat 3, **graph-only**: success; acceptance 100.0%; latency 116896 ms; instruction applied yes; graph preflight passed; first tool `cuppet_graph_search` (compliant); graph calls 18; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 1; blocked bash 1; first graph 5240 ms; first workspace 9731 ms.
- Repeat 4, **current**: incomplete; acceptance 87.5%; latency 94665 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 9; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph 10981 ms; first workspace 6404 ms.
  - Failed: pastDeadline: priority must be low, normal, or high
- Repeat 4, **graph-only**: success; acceptance 100.0%; latency 135167 ms; instruction applied yes; graph preflight passed; first tool `cuppet_graph_search` (compliant); graph calls 16; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 2; blocked bash 2; first graph 2206 ms; first workspace 6734 ms.
- Repeat 5, **graph-only**: success; acceptance 100.0%; latency 97479 ms; instruction applied yes; graph preflight passed; first tool `cuppet_graph_search` (compliant); graph calls 14; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 3; blocked bash 3; first graph 4944 ms; first workspace 9047 ms.
- Repeat 5, **current**: success; acceptance 100.0%; latency 111840 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 11; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph 8778 ms; first workspace 4500 ms.

## Interpretation note

This run used the increased-complexity fixture: priority defaults and
validation, indexed status/priority/tag queries, and a stale-index mutation
defect were added to the original cross-file rename, past-deadline validation,
and two-hop deadline-propagation task. The fixture was reseeded to the legacy
state before evaluation; visible tests and typecheck passed before the agents
started, while the hidden suite retained the new acceptance checks.

Graph-only improved completion from 3/5 to 4/5, mean acceptance from 95.0% to
97.5%, and hop≤1 coverage from 80.0% to 90.0%. Hop2 and regression coverage
were 100.0% in both arms. However, successful graph-only work was 4.4% slower,
used 46.6% more uncached input, and used 43.0% more total model tokens. The
graph arm also made more graph calls because it was constrained to graph-based
navigation and received ten Bash-discovery feedback interventions.

All three incomplete trials failed the same hidden `pastDeadline` assertion:
the implementation accepted an invalid priority. No trial exposed a failure
in the rename, deadline propagation, or index-refresh checks. The result is
therefore a complexity-sensitive accuracy improvement without an efficiency
improvement. OpenCode's `$0` cost telemetry is not a real cost measurement.

Interpretation must remain task-specific. This tests whether the graph can supply enough file navigation when ordinary file search is unavailable; it is a constrained graph-assisted workflow, not a pure prompt-wording comparison. 5 repeats per arm provide directional evidence, not a product-wide statistical claim.
