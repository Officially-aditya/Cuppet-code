# Task Tracker graph-native agent-profile experiment

- Created: 2026-07-23T13:37:10.995Z
- Model: `openai/gpt-5.6-luna@low`
- Repeats per arm: 5
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
| current | 3/5 | 85.0% | 60.0% | 60.0% | 121286 ms | 115559 ms | $0.000000 | 62867 | 1252 | 100.0% | 100.0% | 0 | 0 | 0 | 0 | 0 | 0.0% | 0.0% | 6.8 | 9903 ms | 5402 ms |
| graph-native | 2/5 | 77.5% | 40.0% | 40.0% | 903205 ms | 110651 ms | $0.000000 | 78897.5 | 1252 | 100.0% | 100.0% | 0 | 0 | 0 | 0 | 0 | 0.0% | 0.0% | 3.8 | 10421 ms | 5979 ms |

Successful-only latency, token, and cost metrics are primary efficiency measures; all-trial medians retain the cost of early incomplete sessions.

## Controlled instruction effect

| Comparison | Completion Δ | Acceptance Δ | Successful latency reduction | Successful cost reduction | Successful token reduction | Hop≤1 Δ | Hop2 Δ |
|---|---:|---:|---:|---:|---:|---:|---:|
| graph-native vs current | -20.0% | -7.5% | 4.2% | 0.0% | -25.5% | -20.0% | -20.0% |

## Trial details

- Repeat 1, **current**: success; acceptance 100.0%; latency 115559 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 9; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph 9996 ms; first workspace 5403 ms.
- Repeat 1, **graph-native**: success; acceptance 100.0%; latency 119086 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 9; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph 10863 ms; first workspace 7056 ms.
- Repeat 2, **graph-native**: success; acceptance 100.0%; latency 102216 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 10; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph 9979 ms; first workspace 4902 ms.
- Repeat 2, **current**: success; acceptance 100.0%; latency 121286 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 13; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph 9758 ms; first workspace 4994 ms.
- Repeat 3, **current**: success; acceptance 100.0%; latency 112166 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 12; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph 9903 ms; first workspace 5402 ms.
- Repeat 3, **graph-native**: incomplete; acceptance 62.5%; latency 903205 ms; instruction applied yes; graph preflight passed; first tool `none` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph —; first workspace —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 4, **current**: incomplete; acceptance 62.5%; latency 902800 ms; instruction applied yes; graph preflight passed; first tool `none` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph —; first workspace —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 4, **graph-native**: incomplete; acceptance 62.5%; latency 904478 ms; instruction applied yes; graph preflight passed; first tool `none` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph —; first workspace —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 5, **graph-native**: incomplete; acceptance 62.5%; latency 904139 ms; instruction applied yes; graph preflight passed; first tool `none` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph —; first workspace —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 5, **current**: incomplete; acceptance 62.5%; latency 904405 ms; instruction applied yes; graph preflight passed; first tool `none` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph —; first workspace —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'


## Interpretation note

The graph-native profile was implemented in the kernel configuration and
session permission path, not as a prompt-only instruction. A local
fake-provider contract passed: the model payload contained
`cuppet_workspace_info`, `cuppet_graph_tree`, `cuppet_graph_search`, and
`cuppet_graph_trace`, and did not contain `glob`, `grep`, `lsp`, `webfetch`,
`websearch`, or `task`.

The benchmark resumed after one current trial from the failed initial
invocation, so the final report has five trials per arm without rerunning that
paid session. Three graph-native trials and two current trials timed out at
roughly 15 minutes before any tool call. This shared timeout tail dominates
all-trial latency and lowers completion; it should be treated as provider or
session instability, not automatically as a graph cost.

Among successful trials, graph-native latency was 4.2% lower, but uncached
input was 28.1% higher and total model tokens were 25.5% higher. It therefore
did not produce a token-efficiency win. The event log also records `grep`
starts in two successful graph-native trials despite the contract payload
hiding `grep` and no grep permission requests. That discrepancy needs to be
resolved before claiming that the runtime profile fully controls tool
selection.

Interpretation must remain task-specific. This tests tool exposure rather than prompt enforcement: the model cannot select legacy discovery tools because they are absent from its set. 5 repeats per arm provide directional evidence, not a product-wide statistical claim.
