# Issue #4 — three-arm comparison

One repetition per arm, same `openai/gpt-5.6-luna` model and `low` reasoning.
Cuppet is the fresh rerun; OpenCode is the frozen repeat-one baseline; Tura is
the completed fresh run.

| Metric | Cuppet (fresh) | OpenCode (frozen) | Tura Direct (fresh) |
|---|---:|---:|---:|
| Accepted tasks | 11/12 | 11/12 | 10/12 |
| Acceptance checks | 14/15 | 14/15 | 13/15 |
| Total model tokens* | 167,676 | 166,998 | 3,441,061 |
| Total input context** | 4,307,059 | 4,289,956 | 20,527,284 |
| Uncached input | 138,867 | 131,492 | 3,254,708 |
| Cached input | 4,168,192 | 4,158,464 | 17,272,576 |
| Output | 27,279 | 33,856 | 175,223 |
| Reasoning | 1,530 | 1,650 | 11,130 |
| Cache share | 96.8% | 96.9% | 84.1% |
| Tool calls | 112 | 141 | 241 |
| Wall time | 849.795s | 833.498s | 1,346.343s |

\* Total model tokens = uncached input + output + reasoning.

\*\* Total input context = uncached input + cached input.

Failures:

- Cuppet: `long-tool-use-dashboard`
- OpenCode: `long-tool-use-dashboard`
- Tura: `task-tracker-cross-file`, `quiz-game-greenfield`

The fresh Cuppet result is [here](</Users/addy/Downloads/cuppet/benchmarks/results/benchmark-cuppet-harness-comparison-2026-09-06T10-26-19.884Z.json>); the Tura raw result is [here](</Users/addy/Downloads/cuppet/benchmarks/results/benchmark-cuppet-harness-comparison-2026-09-06T09-41-20.085Z.json>).
