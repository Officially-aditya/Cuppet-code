# Task Tracker source-capsule context experiment

- Created: 2026-08-02T06:42:10.843Z
- Model: `openai/gpt-5.6-sol@max`
- Paired repeats: 1
- Both arms used fresh workspaces, the same task/model/evaluator, the same normal workspace tools, and the official OpenCode kernel.
- **current**: existing bounded STM/LTM/graph metadata projection plus the current Cuppet instruction.
- **compiled**: opt-in source-bearing capsule selected from the same TST response; the pre-prompt context helper is disabled so the capsule is the only automatic context injection.

| Metric | Current | Compiled | Compiled vs current |
|---|---:|---:|---:|
| Successful trials | 1/1 | 1/1 | 0.0% |
| Mean acceptance score | 100.0% | 100.0% | 0.0% |
| Median latency | 620237 ms | 655199 ms | -5.6% |
| Median uncached input | 84533 | 1409475 | -1567.4% |
| Median total model tokens | 108180 | 1436283 | -1227.7% |
| Median cost | $0.000000 | $0.000000 | 0.0% |
| Median successful input | 84533 | 1409475 | -1567.4% |
| Median successful total tokens | 108180 | 1436283 | -1227.7% |
| Mean tool calls | 103.0 | 155.0 | lower is better |
| Median injected context | 356 | 0 | compiled plugin capsule is measured in model usage |
| Mean graph calls | 18.0 | 60.0 | lower is better |
| Mean graph output bytes | 26718 | 289078 | lower is better |

## Acceptance by navigation depth

| Check group | Current | Compiled | Δ |
|---|---:|---:|---:|
| Rename + validation (hop ≤ 1) | 100.0% | 100.0% | 0.0% |
| Two-hop deadline propagation | 100.0% | 100.0% | 0.0% |
| Regression checks | 100.0% | 100.0% | 0.0% |

## Trial details

- Repeat 1, **current**: success; acceptance 100.0%; latency 620237 ms; uncached input 84533; total model tokens 108180; tools 103; graph calls 18; graph bytes 26718.
- Repeat 1, **compiled**: success; acceptance 100.0%; latency 655199 ms; uncached input 1409475; total model tokens 1436283; tools 155; graph calls 60; graph bytes 289078.

Interpretation: source-bearing context is promising only if compiled preserves acceptance while reducing uncached input and discovery/tool work. 1 paired repeats provide directional evidence before a larger benchmark.
