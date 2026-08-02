# Task Tracker source-capsule context experiment

- Created: 2026-08-02T08:23:43.439Z
- Model: `openai/gpt-5.6-sol@max`
- Paired repeats: 1
- Both arms used fresh workspaces, the same task/model/evaluator, the same normal workspace tools, and the official OpenCode kernel.
- **current**: existing bounded STM/LTM/graph metadata projection plus the current Cuppet instruction.
- **compiled**: opt-in source-bearing capsule selected from the same TST response; the pre-prompt context helper is disabled so the capsule is the only automatic context injection.

| Metric | Current | Compiled | Compiled vs current |
|---|---:|---:|---:|
| Successful trials | 1/1 | 1/1 | 0.0% |
| Mean acceptance score | 100.0% | 100.0% | 0.0% |
| Median latency | 625814 ms | 563236 ms | 10.0% |
| Median uncached input | 168512 | 87644 | 48.0% |
| Median total model tokens | 189684 | 109431 | 42.3% |
| Median cost | $0.000000 | $0.000000 | 0.0% |
| Median successful input | 168512 | 87644 | 48.0% |
| Median successful total tokens | 189684 | 109431 | 42.3% |
| Mean tool calls | 103.0 | 118.0 | lower is better |
| Median injected context | 356 | 0 | compiled plugin capsule is measured in model usage |
| Mean graph calls | 26.0 | 35.0 | lower is better |
| Mean graph output bytes | 42005 | 42721 | lower is better |

## Acceptance by navigation depth

| Check group | Current | Compiled | Δ |
|---|---:|---:|---:|
| Rename + validation (hop ≤ 1) | 100.0% | 100.0% | 0.0% |
| Two-hop deadline propagation | 100.0% | 100.0% | 0.0% |
| Regression checks | 100.0% | 100.0% | 0.0% |

## Trial details

- Repeat 1, **current**: success; acceptance 100.0%; latency 625814 ms; uncached input 168512; total model tokens 189684; tools 103; graph calls 26; graph bytes 42005.
- Repeat 1, **compiled**: success; acceptance 100.0%; latency 563236 ms; uncached input 87644; total model tokens 109431; tools 118; graph calls 35; graph bytes 42721.

Interpretation: source-bearing context is promising only if compiled preserves acceptance while reducing uncached input and discovery/tool work. 1 paired repeats provide directional evidence before a larger benchmark.
