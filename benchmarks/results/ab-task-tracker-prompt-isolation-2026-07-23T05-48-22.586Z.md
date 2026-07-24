# Task Tracker prompt-isolation experiment

- Created: 2026-07-23T05:48:22.586Z
- Model: `google-vertex/gemini-flash-latest`
- Repeats per arm: 3
- Four fresh-workspace arms were run with the same fixture, model, tools, permissions, hidden evaluator, and official OpenCode kernel.
- External-directory discovery was allowed for every arm with `CUPPET_TTT_ALLOW_EXTERNAL=1`.

## Arms

- **kernel**: raw OpenCode kernel with no Cuppet instruction and no retrieved context.
- **instruction-only**: Cuppet instruction without retrieved context.
- **current**: current Cuppet instruction plus existing bounded TST context.
- **graph-aware**: graph-aware instruction plus the same existing bounded TST context.

## Results

| Arm | Successes | Mean acceptance | Hop≤1 | Hop2 | Median latency | Successful latency | Successful cost | Successful tokens | Context tokens | Mean tools | First search | First edit |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| kernel | 2/3 | 95.8% | 100.0% | 66.7% | 215207 ms | 215916.5 ms | $0.330122 | 80363 | 0 | 34.3 | 6887 ms | 31419 ms |
| instruction-only | 3/3 | 100.0% | 100.0% | 100.0% | 176296 ms | 176296 ms | $0.275322 | 65854 | 0 | 36.0 | 10220 ms | 26673 ms |
| current | 1/3 | 75.0% | 33.3% | 33.3% | 38990 ms | 203330 ms | $0.326113 | 75538 | 1260 | 16.0 | 6414 ms | 21781 ms |
| graph-aware | 2/3 | 87.5% | 66.7% | 66.7% | 217836 ms | 237483.5 ms | $0.355117 | 80764.5 | 1260 | 33.7 | 6864 ms | 29069.5 ms |

Successful-only metrics are the primary efficiency measure; all-trial medians are retained to show the cost of early incomplete sessions.

## Controlled effects

| Effect | Comparison | Completion Δ | Acceptance Δ | Successful latency reduction | Successful cost reduction | Successful token reduction | Hop≤1 Δ | Hop2 Δ |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Instruction effect | instruction-only vs kernel | 33.3% | 4.2% | 18.3% | 16.6% | 18.1% | 0.0% | 33.3% |
| Context effect | current vs instruction-only | -66.7% | -25.0% | -15.3% | -18.4% | -14.7% | -66.7% | -66.7% |
| Prompt wording effect | graph-aware vs current | 33.3% | 12.5% | -16.8% | -8.9% | -6.9% | 33.3% | 33.3% |
| Total Cuppet effect | graph-aware vs kernel | 0.0% | -8.3% | -10.0% | -7.6% | -0.5% | -33.3% | 0.0% |

## Trial details

- Repeat 1, **kernel**: success; acceptance 100.0%; latency 215207 ms; tools 42; first search 16938 ms; first edit 31419 ms.
- Repeat 1, **instruction-only**: success; acceptance 100.0%; latency 176296 ms; tools 35; first search 13474 ms; first edit 26673 ms.
- Repeat 1, **current**: incomplete; acceptance 62.5%; latency 38990 ms; tools 5; first search 5610 ms; first edit —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 1, **graph-aware**: success; acceptance 100.0%; latency 217836 ms; tools 54; first search 6864 ms; first edit 29294 ms.
- Repeat 2, **instruction-only**: success; acceptance 100.0%; latency 179335 ms; tools 38; first search 10220 ms; first edit 31204 ms.
- Repeat 2, **current**: incomplete; acceptance 62.5%; latency 19792 ms; tools 1; first search 9533 ms; first edit —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 2, **graph-aware**: success; acceptance 100.0%; latency 257131 ms; tools 46; first search 6102 ms; first edit 28845 ms.
- Repeat 2, **kernel**: success; acceptance 100.0%; latency 216626 ms; tools 42; first search 6887 ms; first edit 38376 ms.
- Repeat 3, **current**: success; acceptance 100.0%; latency 203330 ms; tools 42; first search 6414 ms; first edit 21781 ms.
- Repeat 3, **graph-aware**: incomplete; acceptance 62.5%; latency 21978 ms; tools 1; first search 8317 ms; first edit —.
  - Failed: renameCoverage: legacy dueDate remains in fixture source

true !== false
 · pastDeadline: past deadline was accepted

true !== false
 · twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 3, **kernel**: incomplete; acceptance 87.5%; latency 62501 ms; tools 19; first search 4650 ms; first edit 28423 ms.
  - Failed: twoHopBug: store addTask still drops deadline
+ actual - expected

+ undefined
- '2099-02-03T00:00:00.000Z'

- Repeat 3, **instruction-only**: success; acceptance 100.0%; latency 155796 ms; tools 35; first search 6318 ms; first edit 18112 ms.

Interpretation must remain task-specific. The prompt wording effect is the graph-aware/current comparison; the context effect is current/instruction-only. Three repeats per arm provide directional evidence, not a product-wide statistical claim.
