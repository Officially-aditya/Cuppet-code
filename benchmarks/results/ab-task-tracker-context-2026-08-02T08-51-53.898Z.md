# Task Tracker task-conditioned relevance context experiment

- Created: 2026-08-02T08:51:53.897Z
- Model: `openai/gpt-5.6-sol@max`
- Paired repeats: 1
- Both arms used fresh workspaces, the same task/model/evaluator, the same normal workspace tools, and the official OpenCode kernel.
- **current**: existing bounded STM/LTM/graph metadata projection plus the current Cuppet instruction.
- **compiled**: confidence-ranked task context selected from explicit task signals, graph/source matches, relationships, and diff evidence; high-confidence files receive source slices while medium-confidence files remain hypotheses; the pre-prompt context helper is disabled.

| Metric | Current | Task context | Task context vs current |
|---|---:|---:|---:|
| Successful trials | 1/1 | 1/1 | 0.0% |
| Mean acceptance score | 100.0% | 100.0% | 0.0% |
| Median latency | 503049 ms | 642465 ms | -27.7% |
| Median uncached input | 106208 | 102567 | 3.4% |
| Median total model tokens | 127846 | 129776 | -1.5% |
| Median cost | $0.000000 | $0.000000 | 0.0% |
| Median successful input | 106208 | 102567 | 3.4% |
| Median successful total tokens | 127846 | 129776 | -1.5% |
| Mean tool calls | 108.0 | 131.0 | lower is better |
| Median injected context | 356 | 0 | task context plugin capsule is measured in model usage |
| Median task capsule chars | undefined | undefined | plugin-injected task capsule only |
| Median high-confidence candidates | undefined | undefined | source-bearing candidates |
| Median medium-confidence candidates | undefined | undefined | hypotheses/diff anchors |
| Mean graph calls | 29.0 | 48.0 | lower is better |
| Mean graph output bytes | 41712 | 42719 | lower is better |

## Acceptance by navigation depth

| Check group | Current | Task context | Δ |
|---|---:|---:|---:|
| Rename + validation (hop ≤ 1) | 100.0% | 100.0% | 0.0% |
| Two-hop deadline propagation | 100.0% | 100.0% | 0.0% |
| Regression checks | 100.0% | 100.0% | 0.0% |

## Trial details

- Repeat 1, **current**: success; acceptance 100.0%; latency 503049 ms; uncached input 106208; total model tokens 127846; tools 108; graph calls 29; graph bytes 41712.
- Repeat 1, **compiled**: success; acceptance 100.0%; latency 642465 ms; uncached input 102567; total model tokens 129776; tools 131; graph calls 48; graph bytes 42719.

Interpretation: task-conditioned relevance context is promising only if compiled preserves acceptance while reducing uncached input and discovery/tool work. 1 paired repeats provide directional evidence before a larger benchmark.
