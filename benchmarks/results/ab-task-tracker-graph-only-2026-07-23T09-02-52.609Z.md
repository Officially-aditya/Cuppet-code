# Task Tracker graph-only file-navigation experiment

- Created: 2026-07-23T09:02:52.608Z
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

| Arm | Successes | Mean acceptance | Hop≤1 | Hop2 | Median latency | Successful latency | Successful cost | Successful tokens | Context tokens | Instruction applied | Preflight passed | Gate denials | Unexpected rejects | Blocked file search | Blocked bash | First tool graph | Graph before workspace | Mean graph calls | First graph | First workspace |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 5/5 | 100.0% | 100.0% | 100.0% | 85494 ms | 85494 ms | $0.000000 | 48585 | 1260 | 100.0% | 100.0% | 0 | 0 | 0 | 0 | 0.0% | 0.0% | 0.0 | — | 4959 ms |
| graph-only | 0/5 | 62.5% | 0.0% | 0.0% | 18092 ms | 0 ms | $0.000000 | 0 | 1260 | 100.0% | 100.0% | 0 | 0 | 0 | 12 | 100.0% | 100.0% | 1.0 | 2834 ms | 9192 ms |

Successful-only latency, token, and cost metrics are primary efficiency measures; all-trial medians retain the cost of early incomplete sessions.

## Controlled instruction effect

| Comparison | Completion Δ | Acceptance Δ | Successful latency reduction | Successful cost reduction | Successful token reduction | Hop≤1 Δ | Hop2 Δ |
|---|---:|---:|---:|---:|---:|---:|---:|
| graph-only vs current | -100.0% | -37.5% | 100.0% | 0.0% | 100.0% | -100.0% | -100.0% |

## Trial details

- Repeat 1, **current**: success; acceptance 100.0%; latency 82489 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 0; first graph —; first workspace 6169 ms.
- Repeat 1, **graph-only**: incomplete; acceptance 62.5%; latency 18092 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 1; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 2; first graph 6131 ms; first workspace 10365 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 2, **graph-only**: incomplete; acceptance 62.5%; latency 15165 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 1; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 3; first graph 3124 ms; first workspace 7661 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 2, **current**: success; acceptance 100.0%; latency 87203 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 0; first graph —; first workspace 4864 ms.
- Repeat 3, **current**: success; acceptance 100.0%; latency 89616 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 0; first graph —; first workspace 4959 ms.
- Repeat 3, **graph-only**: incomplete; acceptance 62.5%; latency 18800 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 1; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 2; first graph 2506 ms; first workspace 10900 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 4, **current**: success; acceptance 100.0%; latency 82177 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 0; first graph —; first workspace 4827 ms.
- Repeat 4, **graph-only**: incomplete; acceptance 62.5%; latency 16152 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 1; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 2; first graph 2756 ms; first workspace 7302 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 5, **graph-only**: incomplete; acceptance 62.5%; latency 18249 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 1; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 3; first graph 2834 ms; first workspace 9192 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 5, **current**: success; acceptance 100.0%; latency 85494 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 0; first graph —; first workspace 6361 ms.

## Validity note

This run did execute real model calls with `openai/gpt-5.6-luna@low`. The
graph-only preflight still ran in a separate session whose graph output was not
passed into the fresh task session. All five graph-only task sessions then
attempted shell-based discovery, producing 12 blocked non-validation `bash`
requests and no edits. The result is therefore strong evidence of failure to
adapt to the graph-only tool constraint, but not a clean test of whether the
returned graph records were sufficient for navigation. OpenCode reported zero
cost despite recording model tokens, so cost comparisons for this provider are
unavailable in this run.

Interpretation must remain task-specific. This tests whether the graph can supply enough file navigation when ordinary file search is unavailable; it is a constrained graph-assisted workflow, not a pure prompt-wording comparison. 5 repeats per arm provide directional evidence, not a product-wide statistical claim.
