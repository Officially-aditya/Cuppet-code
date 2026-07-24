# Task Tracker graph-only file-navigation experiment

- Created: 2026-07-23T09:27:18.134Z
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
| current | 5/5 | 100.0% | 100.0% | 100.0% | 87924 ms | 87924 ms | $0.000000 | 43986 | 1260 | 100.0% | 100.0% | 0 | 0 | 0 | 0 | 0 | 0.0% | 0.0% | 0.0 | — | 5180 ms |
| graph-only | 0/5 | 62.5% | 0.0% | 0.0% | 16388 ms | 0 ms | $0.000000 | 0 | 1260 | 100.0% | 100.0% | 0 | 0 | 0 | 0 | 15 | 100.0% | 100.0% | 1.0 | 2905 ms | 7710 ms |

Successful-only latency, token, and cost metrics are primary efficiency measures; all-trial medians retain the cost of early incomplete sessions.

## Controlled instruction effect

| Comparison | Completion Δ | Acceptance Δ | Successful latency reduction | Successful cost reduction | Successful token reduction | Hop≤1 Δ | Hop2 Δ |
|---|---:|---:|---:|---:|---:|---:|---:|
| graph-only vs current | -100.0% | -37.5% | 100.0% | 0.0% | 100.0% | -100.0% | -100.0% |

## Trial details

- Repeat 1, **current**: success; acceptance 100.0%; latency 94726 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph —; first workspace 4967 ms.
- Repeat 1, **graph-only**: incomplete; acceptance 62.5%; latency 18503 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 1; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 3; first graph 3421 ms; first workspace 11121 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 2, **graph-only**: incomplete; acceptance 62.5%; latency 16388 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 1; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 3; first graph 3187 ms; first workspace 7710 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 2, **current**: success; acceptance 100.0%; latency 88716 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph —; first workspace 5180 ms.
- Repeat 3, **current**: success; acceptance 100.0%; latency 86517 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph —; first workspace 4521 ms.
- Repeat 3, **graph-only**: incomplete; acceptance 62.5%; latency 17278 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 1; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 3; first graph 2850 ms; first workspace 9142 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 4, **current**: success; acceptance 100.0%; latency 87924 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph —; first workspace 5189 ms.
- Repeat 4, **graph-only**: incomplete; acceptance 62.5%; latency 15333 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 1; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 3; first graph 2905 ms; first workspace 7391 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 5, **graph-only**: incomplete; acceptance 62.5%; latency 14970 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 1; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 3; first graph 2746 ms; first workspace 7162 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 5, **current**: success; acceptance 100.0%; latency 80762 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph —; first workspace 5312 ms.

## Intervention note

The new permission-feedback intervention was not exercised: the graph-only arm
made zero `glob`, `grep`, or LSP permission requests and therefore received
zero graph-guidance messages. Instead, it made 15 direct non-validation `bash`
requests, all of which were blocked, and made no edits. The unchanged 0/5
completion result therefore shows the model bypassing the targeted permission
path through shell discovery; it does not measure whether the explanatory
message would have helped after a blocked file-search request.

Interpretation must remain task-specific. This tests whether the graph can supply enough file navigation when ordinary file search is unavailable; it is a constrained graph-assisted workflow, not a pure prompt-wording comparison. 5 repeats per arm provide directional evidence, not a product-wide statistical claim.
