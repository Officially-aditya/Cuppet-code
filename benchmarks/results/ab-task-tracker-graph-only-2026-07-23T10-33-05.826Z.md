# Task Tracker graph-only file-navigation experiment

- Created: 2026-07-23T10:33:05.826Z
- Model: `openai/gpt-5.6-luna@low`
- Repeats per arm: 1
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
| current | 1/1 | 100.0% | 100.0% | 100.0% | 88518 ms | 88518 ms | $0.000000 | 68259 | 1233 | 100.0% | 100.0% | 0 | 0 | 0 | 0 | 0 | 0.0% | 0.0% | 2.0 | 9024 ms | 5088 ms |
| graph-only | 1/1 | 100.0% | 100.0% | 100.0% | 93376 ms | 93376 ms | $0.000000 | 64206 | 1234 | 100.0% | 100.0% | 0 | 0 | 0 | 1 | 1 | 100.0% | 100.0% | 11.0 | 2077 ms | 7436 ms |

Successful-only latency, token, and cost metrics are primary efficiency measures; all-trial medians retain the cost of early incomplete sessions.

## Controlled instruction effect

| Comparison | Completion Δ | Acceptance Δ | Successful latency reduction | Successful cost reduction | Successful token reduction | Hop≤1 Δ | Hop2 Δ |
|---|---:|---:|---:|---:|---:|---:|---:|
| graph-only vs current | 0.0% | 0.0% | -5.5% | 0.0% | 5.9% | 0.0% | 0.0% |

## Trial details

- Repeat 1, **current**: success; acceptance 100.0%; latency 88518 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 2; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph 9024 ms; first workspace 5088 ms.
- Repeat 1, **graph-only**: success; acceptance 100.0%; latency 93376 ms; instruction applied yes; graph preflight passed; first tool `cuppet_graph_search` (compliant); graph calls 11; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 1; blocked bash 1; first graph 2077 ms; first workspace 7436 ms.

## Tool-proxy smoke interpretation

This smoke run used the new explicit graph tools: `cuppet_workspace_info`,
`cuppet_graph_tree`, `cuppet_graph_search`, and `cuppet_graph_trace`. In the
graph-only arm, the model used 6 searches, 4 traces, and 1 tree query, made no
glob/grep/LSP calls, and completed the refactor after one blocked Bash request
returned the graph-navigation feedback. The current arm also used two graph
traces, but still used ordinary glob/grep discovery.

This is evidence that concrete graph tools materially changed tool selection;
it is only one paired repeat, so it does not establish a stable accuracy or
efficiency advantage. OpenCode reported `$0` for both arms, so provider cost
remains unavailable.

Interpretation must remain task-specific. This tests whether the graph can supply enough file navigation when ordinary file search is unavailable; it is a constrained graph-assisted workflow, not a pure prompt-wording comparison. 1 repeat per arm provides directional evidence, not a product-wide statistical claim.
