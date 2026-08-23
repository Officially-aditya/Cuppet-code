# OpenCode vs Cuppet: 8 sequential web projects

- Status: partial
- Created: 2026-08-23T01:03:59.545Z
- Model: `opencode/x-preview-f-free`
- Cuppet context mode: `task-conditioned-relevance`
- Each arm used one persistent foreground session and received the same 8 prompts in the same order. Arms ran concurrently for each task so neither provider prompt cache is evicted by idle time.

| Aggregate metric | OpenCode | Cuppet | Candidate minus baseline |
|---|---:|---:|---:|
| Correct tasks | 3/8 | 3/8 | 0.00 |
| Agent time | 7222635 ms | 7114891 ms | 1.5% |
| End-to-end time | 7222900 ms | 7115083 ms | 1.5% |
| Uncached input tokens | 77910 | 81050 | -4.0% |
| Cache-read tokens | 1237568 | 1702080 | 464512 |
| Cache share | 94.1% | 95.5% | 1.4 pp |
| Cache share (idle-adjusted, ≤180s gaps) | 95.0% | 96.2% | 1.3 pp |
| Correct on first attempt | 3 | 2 | -1 |
| Repair-recovered tasks | 0 | 1 | 1 |
| Full cache-miss steps (excl. first) | 0 | 0 | 0 |
| Total model tokens | 131338 | 134286 | -2.2% |
| Compactions | 0 | 0 | 0 |
| Evaluation checks | 57/123 | 57/123 | 0 |

| Task | OpenCode | Cuppet | OpenCode time | Cuppet time | OpenCode input/cache | Cuppet input/cache | Compactions O/C |
|---|---|---|---:|---:|---:|---:|---:|
| landing-page | pass (15/15) | pass* (15/15) | 463042 ms | 491622 ms | 37706 / 170944 | 46366 / 440704 | 0 / 0 |
| todo-list-app | pass (16/16) | pass (16/16) | 434816 ms | 296708 ms | 16937 / 437440 | 13353 / 535488 | 0 / 0 |
| calculator-web-app | pass (16/16) | pass (16/16) | 463486 ms | 465226 ms | 20594 / 558080 | 21331 / 725888 | 0 / 0 |
| survey-form | fail (2/17) | fail (2/17) | 1040544 ms | 1040597 ms | 2673 / 71104 | 0 / 0 | 0 / 0 |
| personal-blog | fail (2/14) | fail (2/14) | 1183966 ms | 1183966 ms | 0 / 0 | 0 / 0 | 0 / 0 |
| business-portfolio | fail (2/14) | fail (2/14) | 1505590 ms | 1505589 ms | 0 / 0 | 0 / 0 | 0 / 0 |
| quiz-game | fail (2/16) | fail (2/16) | 1061439 ms | 1061433 ms | 0 / 0 | 0 / 0 | 0 / 0 |
| meme-generator | fail (2/15) | fail (2/15) | 1069752 ms | 1069750 ms | 0 / 0 | 0 / 0 | 0 / 0 |

Cache-read tokens are reported separately from uncached input. Reported cost is only meaningful if the provider returns a nonzero cost; token counts alone are not a price calculation.
* = recovered by the verification guard: after a failed attempt, the deterministic evaluator fed exact failed checks back to the same session (up to 2 repairs per task, both arms identically).
