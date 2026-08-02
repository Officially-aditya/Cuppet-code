# Task Tracker source-capsule context experiment

- Created: 2026-08-02T06:13:19.231Z
- Model: `openai/gpt-5.6-sol@max`
- Paired repeats: 1
- Both arms used fresh workspaces, the same task/model/evaluator, the same normal workspace tools, and the official OpenCode kernel.
- **current**: existing bounded STM/LTM/graph metadata projection plus the current Cuppet instruction.
- **compiled**: opt-in source-bearing capsule selected from the same TST response; the pre-prompt context helper is disabled so the capsule is the only automatic context injection.

| Metric | Current | Compiled | Compiled vs current |
|---|---:|---:|---:|
| Successful trials | 1/1 | 1/1 | 0.0% |
| Mean acceptance score | 100.0% | 100.0% | 0.0% |
| Median latency | 447307 ms | 411251 ms | 8.1% |
| Median uncached input | 68715 | 68624 | 0.1% |
| Median total model tokens | 87750 | 86228 | 1.7% |
| Median cost | $0.000000 | $0.000000 | 0.0% |
| Median successful input | 68715 | 68624 | 0.1% |
| Median successful total tokens | 87750 | 86228 | 1.7% |
| Mean tool calls | 83.0 | 78.0 | lower is better |
| Median injected context | 356 | 0 | compiled plugin capsule is measured in model usage |
| Mean graph calls | 38.0 | 27.0 | lower is better |
| Mean graph output bytes | 45243 | 34587 | lower is better |

## Acceptance by navigation depth

| Check group | Current | Compiled | Δ |
|---|---:|---:|---:|
| Rename + validation (hop ≤ 1) | 100.0% | 100.0% | 0.0% |
| Two-hop deadline propagation | 100.0% | 100.0% | 0.0% |
| Regression checks | 100.0% | 100.0% | 0.0% |

## Trial details

- Repeat 1, **current**: success; acceptance 100.0%; latency 447307 ms; uncached input 68715; total model tokens 87750; tools 83; graph calls 38; graph bytes 45243.
- Repeat 1, **compiled**: success; acceptance 100.0%; latency 411251 ms; uncached input 68624; total model tokens 86228; tools 78; graph calls 27; graph bytes 34587.

Interpretation: source-bearing context is promising only if compiled preserves acceptance while reducing uncached input and discovery/tool work. 1 paired repeats provide directional evidence before a larger benchmark.
