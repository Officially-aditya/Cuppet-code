# Task Tracker graph-only file-navigation experiment

- Created: 2026-07-23T08:20:46.562Z
- Model: `google-vertex/gemini-flash-latest`
- Repeats per arm: 5
- Two fresh-workspace arms used the same fixture, model, tools, existing bounded `CUPPET_CONTEXT`, hidden evaluator, and official OpenCode kernel.
- External-directory discovery was allowed for every arm with `CUPPET_TTT_ALLOW_EXTERNAL=1`.
- The graph-only arm ran a mandatory model graph preflight, then used a fresh task session where glob, grep, and LSP were disabled; read/edit/write remained available. Bash was permitted only for the three required validation commands. Any blocked file-search or unapproved bash requests are reported explicitly.

## Arms

- **current**: current Cuppet instruction plus the existing bounded TST context.
- **graph-only**: graph navigation plus read/edit/write access, with ordinary file-search tools disabled and the identical existing bounded TST context.

## Results

| Arm | Successes | Mean acceptance | Hop≤1 | Hop2 | Median latency | Successful latency | Successful cost | Successful tokens | Context tokens | Instruction applied | Preflight passed | Gate denials | Unexpected rejects | Blocked file search | Blocked bash | First tool graph | Graph before workspace | Mean graph calls | First graph | First workspace |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 3/5 | 85.0% | 60.0% | 60.0% | 181606 ms | 246670 ms | $0.376936 | 95956 | 1260 | 100.0% | 100.0% | 0 | 0 | 0 | 0 | 0.0% | 0.0% | 0.0 | — | 7065 ms |
| graph-only | 0/5 | 62.5% | 0.0% | 0.0% | 18724 ms | 0 ms | $0.000000 | 0 | 1260 | 100.0% | 100.0% | 0 | 0 | 0 | 4 | 100.0% | 100.0% | 1.0 | 4747 ms | 15164 ms |

Successful-only latency, token, and cost metrics are primary efficiency measures; all-trial medians retain the cost of early incomplete sessions.

## Controlled instruction effect

| Comparison | Completion Δ | Acceptance Δ | Successful latency reduction | Successful cost reduction | Successful token reduction | Hop≤1 Δ | Hop2 Δ |
|---|---:|---:|---:|---:|---:|---:|---:|
| graph-only vs current | -60.0% | -22.5% | 100.0% | 100.0% | 100.0% | -60.0% | -60.0% |

## Trial details

- Repeat 1, **current**: success; acceptance 100.0%; latency 246670 ms; instruction applied yes; graph preflight passed; first tool `grep` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 0; first graph —; first workspace 7987 ms.
- Repeat 1, **graph-only**: incomplete; acceptance 62.5%; latency 17190 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 1; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 1; first graph 3763 ms; first workspace 14085 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 2, **graph-only**: incomplete; acceptance 62.5%; latency 29968 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 1; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 0; first graph 13955 ms; first workspace —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 2, **current**: success; acceptance 100.0%; latency 181606 ms; instruction applied yes; graph preflight passed; first tool `grep` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 0; first graph —; first workspace 5592 ms.
- Repeat 3, **current**: incomplete; acceptance 62.5%; latency 14891 ms; instruction applied yes; graph preflight passed; first tool `none` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 0; first graph —; first workspace —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 3, **graph-only**: incomplete; acceptance 62.5%; latency 18051 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 1; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 1; first graph 3529 ms; first workspace 14883 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 4, **current**: success; acceptance 100.0%; latency 250198 ms; instruction applied yes; graph preflight passed; first tool `grep` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 0; first graph —; first workspace 6143 ms.
- Repeat 4, **graph-only**: incomplete; acceptance 62.5%; latency 24887 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 1; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 1; first graph 4747 ms; first workspace 18725 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 5, **graph-only**: incomplete; acceptance 62.5%; latency 18724 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 1; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 1; first graph 5500 ms; first workspace 15445 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 5, **current**: incomplete; acceptance 62.5%; latency 20347 ms; instruction applied yes; graph preflight passed; first tool `read` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 0; first graph —; first workspace 11085 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

## Validity note

The graph-only preflight is a compliance gate, not a navigation result supplied
to the task session: the preflight's graph output was not injected into the
fresh task session. All five graph-only trials therefore prove that the model
can be made to execute a graph query first, but they do not prove that it used
the returned graph records to locate files. The task sessions made no edits;
four requested non-validation `bash` and one stopped after the graph preflight.
Consequently, the 0/5 graph-only completion result should be read as evidence
of workflow resistance under the restriction, not as a clean measurement of
graph navigation efficiency.


Interpretation must remain task-specific. This tests whether the graph can supply enough file navigation when ordinary file search is unavailable; it is a constrained graph-assisted workflow, not a pure prompt-wording comparison. 5 repeats per arm provide directional evidence, not a product-wide statistical claim.
