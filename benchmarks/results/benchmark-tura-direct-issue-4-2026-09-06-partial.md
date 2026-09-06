# Tura Direct — Issue #4 partial run

- Status: **incomplete; comparison not eligible**
- Tura: `0.1.37`
- Model: `openai/gpt-5.6-luna`
- Reasoning effort: `low`
- Topology: one persistent marathon session, one requested repetition
- Tasks scheduled: 12
- Tasks executed: 1
- Tura model requests: 1
- Retries/reruns: 0

## What ran

The no-model preflight passed: the installed Tura CLI exposed the required
native session flags, OpenAI authentication was `authenticated` with runtime
`ready`, and the exact `openai/gpt-5.6-luna` catalog entry was present.

Task `task-tracker-cross-file` completed at the Tura harness layer with exact
model resolution and valid JSONL/turn-log telemetry. The deterministic hidden
verifier then failed with:

```text
Error: priority must be low, normal, or high
```

The run was stopped before `quiz-game-greenfield`. No automatic retry or rerun
was made. The preserved raw result and Tura sidecars are under
`.benchmarks/cuppet-harness-comparison-PGcDUs/`.

## Task 1 telemetry

| Metric | Value |
|---|---:|
| Input tokens | 396,014 |
| Cached input tokens | 285,696 |
| Uncached input tokens | 110,318 |
| Output tokens | 3,806 |
| Reasoning tokens | 452 |
| Normalized model tokens | 114,576 |
| Tool calls | 7 |
| Compactions | 0 |
| Duration | 120.411s |
| Effective cost | unavailable |

The frozen Cuppet/OpenCode baseline remains available in the JSON artifact, but
Tura has no full-run result, so no ranking or comparison is reported.

## Verification of the integration

- Tura arm and runner typecheck: passed.
- Benchmark contract tests: 3/3 passed.
- Tura no-model preflight: passed.
- Tura-only dry run: passed; 12 tasks, one arm, one repetition, exact Luna/low settings.
- Cuppet/OpenCode were not rerun.
