# OpenCode vs Cuppet: 8 sequential web projects

- Status: partial
- Created: 2026-08-23T09:21:09.722Z
- Model: `opencode/x-preview-f-free`
- Cuppet context mode: `task-conditioned-relevance`
- Each arm used one persistent foreground session and received the same 8 prompts in the same order. Arms ran concurrently for each task so neither provider prompt cache is evicted by idle time.

| Aggregate metric | OpenCode | Cuppet | Candidate minus baseline |
|---|---:|---:|---:|
| Correct tasks | 2/4 | 1/3 | -0.17 |
| Agent time | 2612410 ms | 2316101 ms | 11.3% |
| End-to-end time | 2612665 ms | 2316115 ms | 11.4% |
| Uncached input tokens | 52201 | 56071 | -7.4% |
| Cache-read tokens | 833408 | 319808 | -513600 |
| Cache share | 94.1% | 85.1% | -9.0 pp |
| Cache share (idle-adjusted, ≤180s gaps) | 95.4% | 92.3% | -3.1 pp |
| Correct on first attempt | 1 | 1 | 0 |
| Repair-recovered tasks | 1 | 0 | -1 |
| Full cache-miss steps (excl. first) | 0 | 0 | 0 |
| Total model tokens | 82866 | 79472 | 4.1% |
| Compactions | 0 | 0 | 0 |
| Evaluation checks | 37/63 | 19/45 | -18 |

| Task | OpenCode | Cuppet | OpenCode time | Cuppet time | OpenCode input/cache | Cuppet input/cache | Compactions O/C |
|---|---|---|---:|---:|---:|---:|---:|
| landing-page | pass (15/15) | pass (15/15) | 421277 ms | 515178 ms | 33300 / 269824 | 56071 / 319808 | 0 / 0 |
| todo-list-app | fail (2/15) | fail (2/15) | 900292 ms | 900307 ms | 0 / 0 | 0 / 0 | 0 / 0 |
| calculator-web-app | fail (2/15) | fail (2/15) | 900411 ms | 900616 ms | 0 / 0 | 0 / 0 | 0 / 0 |
| survey-form | pass* (18/18) | fail (0/0) | 390430 ms | 0 ms | 18901 / 563584 | 0 / 0 | 0 / 0 |
| personal-blog | fail (0/0) | fail (0/0) | 0 ms | 0 ms | 0 / 0 | 0 / 0 | 0 / 0 |
| business-portfolio | fail (0/0) | fail (0/0) | 0 ms | 0 ms | 0 / 0 | 0 / 0 | 0 / 0 |
| quiz-game | fail (0/0) | fail (0/0) | 0 ms | 0 ms | 0 / 0 | 0 / 0 | 0 / 0 |
| meme-generator | fail (0/0) | fail (0/0) | 0 ms | 0 ms | 0 / 0 | 0 / 0 | 0 / 0 |

Cache-read tokens are reported separately from uncached input. Reported cost is only meaningful if the provider returns a nonzero cost; token counts alone are not a price calculation.
* = recovered by the verification guard: after a failed attempt, the deterministic evaluator fed exact failed checks back to the same session (up to 2 repairs per task, both arms identically).
