# OpenCode vs Cuppet: 3 sequential web projects

- Status: partial
- Created: 2026-08-03T05:52:21.905Z
- Model: `openai/gpt-5.6-luna`, variant: `low`
- Cuppet context mode: `task-conditioned-relevance`
- Random task selection seed: `20260803-relevance-v1` (landing-page, address-book, survey-form)
- Each arm used one persistent foreground session and received the same 3 prompts in the same order. Arms were alternated between tasks.

| Aggregate metric | OpenCode | Cuppet | Candidate minus baseline |
|---|---:|---:|---:|
| Correct tasks | 0/3 | 0/3 | 0.00 |
| Agent time | 3372 ms | 2706 ms | 19.8% |
| End-to-end time | 3377 ms | 2709 ms | 19.8% |
| Uncached input tokens | 0 | 0 | 0.0% |
| Cache-read tokens | 0 | 0 | 0 |
| Cache share | 0.0% | 0.0% | 0.0 pp |
| Total model tokens | 0 | 0 | 0.0% |
| Compactions | 0 | 0 | 0 |
| Evaluation checks | 6/48 | 6/48 | 0 |

| Task | OpenCode | Cuppet | OpenCode time | Cuppet time | OpenCode input/cache | Cuppet input/cache | Compactions O/C |
|---|---|---|---:|---:|---:|---:|---:|
| landing-page | fail (2/15) | fail (2/15) | 1780 ms | 1184 ms | 0 / 0 | 0 / 0 | 0 / 0 |
| address-book | fail (2/16) | fail (2/16) | 800 ms | 736 ms | 0 / 0 | 0 / 0 | 0 / 0 |
| survey-form | fail (2/17) | fail (2/17) | 792 ms | 786 ms | 0 / 0 | 0 / 0 | 0 / 0 |

Cache-read tokens are reported separately from uncached input. Reported cost is only meaningful if the provider returns a nonzero cost; token counts alone are not a price calculation.
