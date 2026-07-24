# Task Tracker graph-only file-navigation experiment

- Created: 2026-07-23T09:51:31.155Z
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
| current | 5/5 | 100.0% | 100.0% | 100.0% | 84566 ms | 84566 ms | $0.000000 | 35000 | 1260 | 100.0% | 100.0% | 0 | 0 | 0 | 0 | 0 | 0.0% | 0.0% | 0.0 | — | 4834 ms |
| graph-only | 1/5 | 70.0% | 20.0% | 20.0% | 16423 ms | 99318 ms | $0.000000 | 52544 | 1260 | 100.0% | 100.0% | 0 | 0 | 0 | 13 | 13 | 100.0% | 100.0% | 1.6 | 3388 ms | 8219 ms |

Successful-only latency, token, and cost metrics are primary efficiency measures; all-trial medians retain the cost of early incomplete sessions.

## Controlled instruction effect

| Comparison | Completion Δ | Acceptance Δ | Successful latency reduction | Successful cost reduction | Successful token reduction | Hop≤1 Δ | Hop2 Δ |
|---|---:|---:|---:|---:|---:|---:|---:|
| graph-only vs current | -80.0% | -30.0% | -17.4% | 0.0% | -50.1% | -80.0% | -80.0% |

## Trial details

- Repeat 1, **current**: success; acceptance 100.0%; latency 82650 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph —; first workspace 6037 ms.
- Repeat 1, **graph-only**: incomplete; acceptance 62.5%; latency 18515 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 1; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 3; blocked bash 3; first graph 5152 ms; first workspace 9677 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 2, **graph-only**: incomplete; acceptance 62.5%; latency 16423 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 1; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 3; blocked bash 3; first graph 4264 ms; first workspace 8923 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 2, **current**: success; acceptance 100.0%; latency 84640 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph —; first workspace 4490 ms.
- Repeat 3, **current**: success; acceptance 100.0%; latency 84566 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph —; first workspace 4638 ms.
- Repeat 3, **graph-only**: incomplete; acceptance 62.5%; latency 14859 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 1; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 3; blocked bash 3; first graph 3039 ms; first workspace 7551 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 4, **current**: success; acceptance 100.0%; latency 86980 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph —; first workspace 4872 ms.
- Repeat 4, **graph-only**: incomplete; acceptance 62.5%; latency 15455 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 1; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 3; blocked bash 3; first graph 3038 ms; first workspace 7482 ms.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 5, **graph-only**: success; acceptance 100.0%; latency 99318 ms; instruction applied yes; graph preflight passed; first tool `cuppet_memory_search` (compliant); graph calls 4; graph before workspace yes; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 1; blocked bash 1; first graph 3388 ms; first workspace 8219 ms.
- Repeat 5, **current**: success; acceptance 100.0%; latency 81570 ms; instruction applied yes; graph preflight passed; first tool `todowrite` (violation); graph calls 0; graph before workspace no; gate denials 0; unexpected rejects 0; blocked file search 0; graph guidance messages 0; blocked bash 0; first graph —; first workspace 4834 ms.

## Interpretation note

This is the requested comparison of the current Cuppet workflow against the
Bash-feedback method. The feedback arm is the `graph-only` arm: graph traversal
was enforced before the task session, glob/grep/LSP were unavailable, and
non-validation Bash received an explicit message directing the model to
`cuppet_memory_search`, exact-path reads, and edit/write. All 13 guidance
messages were triggered by Bash; no file-search request reached the feedback
handler.

The mandatory preflight proved that graph traversal occurred, but its result was
not injected into the fresh task session. The one successful feedback trial
continued with additional graph queries after Bash feedback; the four failed
trials stopped after repeated shell-discovery attempts. Therefore the result
shows a repeatable failure mode in the model/tool interaction, not that the
graph's returned records are intrinsically insufficient.

OpenCode reported `$0` for both arms even though model tokens were recorded, so
provider cost is unavailable rather than genuinely zero. The low all-trial
latency/token medians for the feedback arm are dominated by four incomplete
trials and must not be treated as efficiency wins. On successful work only, the
feedback arm was slower and used more tokens in this run.

Interpretation must remain task-specific. This tests whether the graph can supply enough file navigation when ordinary file search is unavailable; it is a constrained graph-assisted workflow, not a pure prompt-wording comparison. 5 repeats per arm provide directional evidence, not a product-wide statistical claim.
