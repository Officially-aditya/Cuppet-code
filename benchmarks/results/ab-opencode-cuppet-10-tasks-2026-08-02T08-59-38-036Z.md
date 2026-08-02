# OpenCode vs Cuppet: 2 sequential web projects

- Status: completed
- Created: 2026-08-02T08:59:38.036Z
- Model: `openai/gpt-5.6-luna`, variant: `low`
- Cuppet context mode: `task-conditioned-relevance`
- Each arm used one persistent foreground session and received the same 2 prompts in the same order. Arms were alternated between tasks.

| Aggregate metric | OpenCode | Cuppet | Candidate minus baseline |
|---|---:|---:|---:|
| Correct tasks | 2/2 | 2/2 | 0.00 |
| Agent time | 188536 ms | 199560 ms | -5.8% |
| End-to-end time | 188628 ms | 199653 ms | -5.8% |
| Uncached input tokens | 29970 | 32986 | -10.1% |
| Cache-read tokens | 280576 | 278016 | -2560 |
| Cache share | 90.3% | 89.4% | -1.0 pp |
| Total model tokens | 37926 | 41560 | -9.6% |
| Compactions | 0 | 0 | 0 |
| Evaluation checks | 32/32 | 32/32 | 0 |

| Task | OpenCode | Cuppet | OpenCode time | Cuppet time | OpenCode input/cache | Cuppet input/cache | Compactions O/C |
|---|---|---|---:|---:|---:|---:|---:|
| todo-list-app | pass (16/16) | pass (16/16) | 95344 ms | 106022 ms | 19175 / 121344 | 23504 / 115200 | 0 / 0 |
| calculator-web-app | pass (16/16) | pass (16/16) | 93192 ms | 93538 ms | 10795 / 159232 | 9482 / 162816 | 0 / 0 |

Cache-read tokens are reported separately from uncached input. Reported cost is only meaningful if the provider returns a nonzero cost; token counts alone are not a price calculation.
