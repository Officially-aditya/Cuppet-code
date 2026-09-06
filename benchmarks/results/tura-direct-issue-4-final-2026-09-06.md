# Tura Direct — Issue #4 final benchmark

- Status: **completed run; 10/12 tasks accepted**
- Tura: `0.1.37`
- Model: `openai/gpt-5.6-luna`
- Reasoning effort: `low`
- Parity: **exact**
- Topology: one persistent marathon session
- Repetitions: 1
- Retries: 0
- Cuppet/OpenCode reruns: 0

## Result

Tura completed all 12 prompts in one session. Ten tasks passed deterministic
acceptance; two failed verifier checks:

| Task | Result | Failure |
|---|---|---|
| `task-tracker-cross-file` | failed | `priority must be low, normal, or high` |
| `quiz-game-greenfield` | failed | `quiz-game has too few local records` |

The remaining 10 tasks passed. The failures are task-quality outcomes, not
provider, router, timeout, or telemetry failures.

## Telemetry comparison

| Metric | Tura Direct | Cuppet baseline | OpenCode baseline |
|---|---:|---:|---:|
| Tasks accepted | 10/12 | frozen baseline | frozen baseline |
| Total model tokens | 3,441,061 | 146,476 | 166,998 |
| Uncached input tokens | 3,254,708 | 122,007 | 131,492 |
| Cached input tokens | 17,272,576 | 3,087,360 | 4,158,464 |
| Tool calls | 241 | 101 | 141 |
| Wall time | 1,346.343s | 594s | 833s |
| Retries | 0 | frozen baseline | frozen baseline |
| Effective cost | unavailable | unavailable | unavailable |

Tura used 3,294,585 more model tokens and 752.343 more seconds than the frozen
Cuppet telemetry, and 3,274,063 more model tokens and 513.343 more seconds than
the frozen OpenCode telemetry. These are raw telemetry comparisons for the same
12-task sequence; acceptance quality is reported separately above.

## Long-horizon behavior

- Total uncached input: `3,254,708`
- Total cached input: `17,272,576`
- Early uncached-input median: `195,356`
- Late uncached-input median: `344,356`
- Early cache-share median: `69.9%`
- Late cache-share median: `84.8%`

## Reproduction and raw artifacts

The exact command and frozen raw report are recorded in the companion JSON:

- [Comparison JSON](</Users/addy/Downloads/cuppet/benchmarks/results/tura-direct-issue-4-final-2026-09-06.json>)
- [Runner JSON](</Users/addy/Downloads/cuppet/benchmarks/results/benchmark-cuppet-harness-comparison-2026-09-06T09-41-20.085Z.json>)
- [Runner Markdown](</Users/addy/Downloads/cuppet/benchmarks/results/benchmark-cuppet-harness-comparison-2026-09-06T09-41-20.085Z.md>)
- [Raw run directory](</Users/addy/Downloads/cuppet/.benchmarks/cuppet-harness-comparison-qKv57A>)

The native router/session-db processes were closed after completion; no active
Tura benchmark process remains.
