# Task Tracker graph-only file-navigation experiment

- Created: 2026-07-23T08:33:00.949Z
- Model: `openai/gpt-5.6-luna@low`
- Repeats per arm: 5

## Invalid run — provider unavailable

No model generation occurred in any of the 10 trials: both arms recorded zero
model tokens, zero tool calls, and zero cost. OpenCode reported
`ProviderModelNotFoundError` for `openai/gpt-5.6-luna`; the local catalog lists
that model and its `low` variant, but the connected-provider list does not
include OpenAI. This artifact is retained for diagnosis, not as benchmark
evidence.

- Two fresh-workspace arms used the same fixture, model, tools, existing bounded `CUPPET_CONTEXT`, hidden evaluator, and official OpenCode kernel.
- External-directory discovery was allowed for every arm with `CUPPET_TTT_ALLOW_EXTERNAL=1`.
- The graph-only arm ran a mandatory model graph preflight, then used a fresh task session where glob, grep, and LSP were disabled; read/edit/write remained available. Bash was permitted only for the three required validation commands. Any blocked file-search or unapproved bash requests are reported explicitly.

## Arms

- **current**: current Cuppet instruction plus the existing bounded TST context.
- **graph-only**: graph navigation plus read/edit/write access, with ordinary file-search tools disabled and the identical existing bounded TST context.

## Results

| Arm | Successes | Mean acceptance | Hop≤1 | Hop2 | Median latency | Successful latency | Successful cost | Successful tokens | Context tokens | Instruction applied | Preflight passed | Gate denials | Unexpected rejects | Blocked file search | Blocked bash | First tool graph | Graph before workspace | Mean graph calls | First graph | First workspace |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| current | 0/5 | 62.5% | 0.0% | 0.0% | 4398 ms | 0 ms | $0.000000 | 0 | 1260 | 100.0% | 100.0% | 0 | 0 | 0 | 0 | 0.0% | 0.0% | 0.0 | — | — |
| graph-only | 0/5 | 62.5% | 0.0% | 0.0% | 3150 ms | 0 ms | $0.000000 | 0 | 0 | 100.0% | 0.0% | 0 | 0 | 0 | 0 | 0.0% | 0.0% | 0.0 | — | — |

Successful-only latency, token, and cost metrics are primary efficiency measures; all-trial medians retain the cost of early incomplete sessions.

## Controlled instruction effect

| Comparison | Completion Δ | Acceptance Δ | Successful latency reduction | Successful cost reduction | Successful token reduction | Hop≤1 Δ | Hop2 Δ |
|---|---:|---:|---:|---:|---:|---:|---:|
| graph-only vs current | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |

## Trial details

- Repeat 1, **current**: incomplete; acceptance 62.5%; latency 4594 ms; instruction applied yes; graph preflight passed; first tool `none` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 0; first graph —; first workspace —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 1, **graph-only**: incomplete; acceptance 62.5%; latency 3160 ms; instruction applied yes; graph preflight failed; first tool `none` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 0; first graph —; first workspace —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 2, **graph-only**: incomplete; acceptance 62.5%; latency 3099 ms; instruction applied yes; graph preflight failed; first tool `none` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 0; first graph —; first workspace —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 2, **current**: incomplete; acceptance 62.5%; latency 4387 ms; instruction applied yes; graph preflight passed; first tool `none` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 0; first graph —; first workspace —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 3, **current**: incomplete; acceptance 62.5%; latency 4420 ms; instruction applied yes; graph preflight passed; first tool `none` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 0; first graph —; first workspace —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 3, **graph-only**: incomplete; acceptance 62.5%; latency 3156 ms; instruction applied yes; graph preflight failed; first tool `none` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 0; first graph —; first workspace —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 4, **current**: incomplete; acceptance 62.5%; latency 4398 ms; instruction applied yes; graph preflight passed; first tool `none` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 0; first graph —; first workspace —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 4, **graph-only**: incomplete; acceptance 62.5%; latency 3114 ms; instruction applied yes; graph preflight failed; first tool `none` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 0; first graph —; first workspace —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 5, **graph-only**: incomplete; acceptance 62.5%; latency 3150 ms; instruction applied yes; graph preflight failed; first tool `none` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 0; first graph —; first workspace —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 5, **current**: incomplete; acceptance 62.5%; latency 4380 ms; instruction applied yes; graph preflight passed; first tool `none` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; blocked bash 0; first graph —; first workspace —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'


Interpretation must remain task-specific. This tests whether the graph can supply enough file navigation when ordinary file search is unavailable; it is a constrained graph-assisted workflow, not a pure prompt-wording comparison. 5 repeats per arm provide directional evidence, not a product-wide statistical claim.
