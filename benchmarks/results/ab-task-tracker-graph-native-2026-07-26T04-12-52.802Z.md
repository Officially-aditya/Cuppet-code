# Task Tracker graph-native agent-profile experiment

- Created: 2026-07-26T04:12:52.802Z
- Model: `openai/gpt-5.6-luna@high`
- Repeats per arm: 1
- Two fresh-workspace arms used the same fixture, model, tools, existing bounded `CUPPET_CONTEXT`, hidden evaluator, and official OpenCode kernel.
- External-directory discovery was allowed for every arm with `CUPPET_TTT_ALLOW_EXTERNAL=1`.
- Configured OpenCode provider credentials/database and cached model catalog were copied into each disposable runtime; those copies are removed after evaluation.
- The graph-native arm used a kernel-level foreground-agent tool allowlist: legacy glob, grep, LSP, web, task, and other unlisted tools were not exposed to the model; graph navigation, read, edit/write, Bash, planning, and question tools remained available. No graph preflight or permission feedback was added.

## Arms

- **current**: current Cuppet instruction plus the existing bounded TST context.
- **graph-native**: current Cuppet instruction and bounded TST context with the kernel graph-native tool profile.

## Results

| Arm | Successes | Mean acceptance | Hop≤1 | Hop2 | Median latency | Successful latency | Successful cost | Successful tokens | Context tokens | Instruction applied | Preflight passed | Gate denials | Unexpected rejects | Blocked file search | Graph guidance messages | Blocked bash | First tool graph | Graph before workspace | Mean graph calls | First graph | First workspace |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 1/1 | 100.0% | 100.0% | 100.0% | 195996 ms | 195996 ms | $0.000000 | 119336 | 1259 | 100.0% | 100.0% | 0 | 0 | 0 | 0 | 0 | 0.0% | 0.0% | 23.0 | 11941 ms | 5370 ms |
| graph-native | 1/1 | 100.0% | 100.0% | 100.0% | 190496 ms | 190496 ms | $0.000000 | 104712 | 1259 | 100.0% | 100.0% | 0 | 0 | 0 | 0 | 0 | 0.0% | 0.0% | 16.0 | 13049 ms | 8047 ms |

Successful-only latency, token, and cost metrics are primary efficiency measures; all-trial medians retain the cost of early incomplete sessions.

## Controlled instruction effect

| Comparison | Completion Δ | Acceptance Δ | Successful latency reduction | Successful cost reduction | Successful token reduction | Hop≤1 Δ | Hop2 Δ |
|---|---:|---:|---:|---:|---:|---:|---:|
| graph-native vs current | 0.0% | 0.0% | 2.8% | 0.0% | 12.3% | 0.0% | 0.0% |

## Trial details

- Repeat 1, **current**: success; acceptance 100.0%; latency 195996 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 23; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph 11941 ms; first workspace 5370 ms.
- Repeat 1, **graph-native**: success; acceptance 100.0%; latency 190496 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 16; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph 13049 ms; first workspace 8047 ms.

Interpretation must remain task-specific. This tests tool exposure rather than prompt enforcement: the model cannot select legacy discovery tools because they are absent from its tool set. 1 repeats per arm provide directional evidence, not a product-wide statistical claim.
