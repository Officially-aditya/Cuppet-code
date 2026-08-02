# OpenCode vs Cuppet: 2 sequential web projects

- Status: partial
- Created: 2026-08-01T20:53:46.983Z
- Model: `openai/gpt-5.6-luna`, variant: `low`
- Cuppet context mode: `graph-only-768`
- Each arm used one persistent foreground session and received the same 2 prompts in the same order. Arms were alternated between tasks.

| Aggregate metric | OpenCode | Cuppet | Candidate minus baseline |
|---|---:|---:|---:|
| Correct tasks | 2/2 | 2/2 | 0.00 |
| Agent time | 265695 ms | 237790 ms | 10.5% |
| End-to-end time | 265745 ms | 237843 ms | 10.5% |
| Uncached input tokens | 39141 | 38757 | 1.0% |
| Cache-read tokens | 309248 | 304640 | -4608 |
| Cache share | 88.8% | 88.7% | -0.1 pp |
| Total model tokens | 51693 | 49731 | 3.8% |
| Compactions | 0 | 0 | 0 |
| Evaluation checks | 31/31 | 31/31 | 0 |

| Task | OpenCode | Cuppet | OpenCode time | Cuppet time | OpenCode input/cache | Cuppet input/cache | Compactions O/C |
|---|---|---|---:|---:|---:|---:|---:|
| landing-page | pass (15/15) | pass (15/15) | 154578 ms | 132229 ms | 28344 / 132096 | 27655 / 117248 | 0 / 0 |
| todo-list-app | pass (16/16) | pass (16/16) | 111117 ms | 105561 ms | 10797 / 177152 | 11102 / 187392 | 0 / 0 |

Cache-read tokens are reported separately from uncached input. Reported cost is only meaningful if the provider returns a nonzero cost; token counts alone are not a price calculation.
