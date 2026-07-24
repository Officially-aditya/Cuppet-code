# Task Tracker graph-only file-navigation experiment

- Created: 2026-07-23T09:35:34.166Z
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
| current | 1/1 | 100.0% | 100.0% | 100.0% | 99923 ms | 99923 ms | $0.000000 | 42700 | 1260 | 100.0% | 100.0% | 0 | 0 | 0 | 0 | 0 | 0.0% | 0.0% | 0.0 | — | 4684 ms |
| graph-only | 1/1 | 100.0% | 100.0% | 100.0% | 97982 ms | 97982 ms | $0.000000 | 38601 | 1260 | 100.0% | 100.0% | 0 | 0 | 0 | 3 | 3 | 100.0% | 100.0% | 4.0 | 2902 ms | 7444 ms |

Successful-only latency, token, and cost metrics are primary efficiency measures; all-trial medians retain the cost of early incomplete sessions.

## Controlled instruction effect

| Comparison | Completion Δ | Acceptance Δ | Successful latency reduction | Successful cost reduction | Successful token reduction | Hop≤1 Δ | Hop2 Δ |
|---|---:|---:|---:|---:|---:|---:|---:|
| graph-only vs current | 0.0% | 0.0% | 1.9% | 0.0% | 9.6% | 0.0% | 0.0% |

## Trial details

- Repeat 1, **current**: success; acceptance 100.0%; latency 99923 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph —; first workspace 4684 ms.
- Repeat 1, **graph-only**: success; acceptance 100.0%; latency 97982 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 4; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 3; blocked bash 3; first graph 2902 ms; first workspace 7444 ms.

## Single-rerun observation

The graph-only task succeeded after three non-validation Bash requests were
rejected with the new guidance message. It then made four graph queries,
fourteen reads, and an edit, passing all hidden checks. This is evidence that
the feedback can redirect the model in at least one trial, but the sample is
only one pair and cannot establish a repeatable effect.

Interpretation must remain task-specific. This tests whether the graph can supply enough file navigation when ordinary file search is unavailable; it is a constrained graph-assisted workflow, not a pure prompt-wording comparison. 1 repeats per arm provide directional evidence, not a product-wide statistical claim.
