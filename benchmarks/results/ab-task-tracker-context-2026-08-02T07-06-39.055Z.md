# Task Tracker source-capsule context experiment

- Created: 2026-08-02T07:06:39.055Z
- Model: `openai/gpt-5.6-sol@max`
- Paired repeats: 1
- Both arms used fresh workspaces, the same task/model/evaluator, the same normal workspace tools, and the official OpenCode kernel.
- **current**: existing bounded STM/LTM/graph metadata projection plus the current Cuppet instruction.
- **compiled**: opt-in source-bearing capsule selected from the same TST response; the pre-prompt context helper is disabled so the capsule is the only automatic context injection.

| Metric | Current | Compiled | Compiled vs current |
|---|---:|---:|---:|
| Successful trials | 1/1 | 1/1 | 0.0% |
| Mean acceptance score | 100.0% | 100.0% | 0.0% |
| Median latency | 558221 ms | 597123 ms | -7.0% |
| Median uncached input | 121038 | 164349 | -35.8% |
| Median total model tokens | 143838 | 186245 | -29.5% |
| Median cost | $0.000000 | $0.000000 | 0.0% |
| Median successful input | 121038 | 164349 | -35.8% |
| Median successful total tokens | 143838 | 186245 | -29.5% |
| Mean tool calls | 115.0 | 138.0 | lower is better |
| Median injected context | 356 | 0 | compiled plugin capsule is measured in model usage |
| Mean graph calls | 22.0 | 43.0 | lower is better |
| Mean graph output bytes | 22600 | 143260 | lower is better |

## Acceptance by navigation depth

| Check group | Current | Compiled | Δ |
|---|---:|---:|---:|
| Rename + validation (hop ≤ 1) | 100.0% | 100.0% | 0.0% |
| Two-hop deadline propagation | 100.0% | 100.0% | 0.0% |
| Regression checks | 100.0% | 100.0% | 0.0% |

## Trial details

- Repeat 1, **current**: success; acceptance 100.0%; latency 558221 ms; uncached input 121038; total model tokens 143838; tools 115; graph calls 22; graph bytes 22600.
- Repeat 1, **compiled**: success; acceptance 100.0%; latency 597123 ms; uncached input 164349; total model tokens 186245; tools 138; graph calls 43; graph bytes 143260.

Interpretation: source-bearing context is promising only if compiled preserves acceptance while reducing uncached input and discovery/tool work. 1 paired repeats provide directional evidence before a larger benchmark.
