# OpenCode vs Cuppet: 8 sequential web projects

- Status: completed
- Created: 2026-08-23T10:11:50.784Z
- Model: `opencode/x-preview-f-free`
- Cuppet context mode: `task-conditioned-relevance`
- Each arm used one persistent foreground session and received the same 8 prompts in the same order. Arms ran concurrently for each task so neither provider prompt cache is evicted by idle time.

| Aggregate metric | OpenCode | Cuppet | Candidate minus baseline |
|---|---:|---:|---:|
| Correct tasks | 8/8 | 8/8 | 0.00 |
| Agent time | 3009459 ms | 3432555 ms | -14.1% |
| End-to-end time | 3010082 ms | 3433197 ms | -14.1% |
| Uncached input tokens | 144701 | 142795 | 1.3% |
| Cache-read tokens | 6525632 | 8812544 | 2286912 |
| Cache share | 97.8% | 98.4% | 0.6 pp |
| Cache share (idle-adjusted, ≤180s gaps) | 98.0% | 98.6% | 0.6 pp |
| Correct on first attempt | 6 | 5 | -1 |
| Repair-recovered tasks | 2 | 3 | 1 |
| Full cache-miss steps (excl. first) | 0 | 0 | 0 |
| Total model tokens | 259488 | 243636 | 6.1% |
| Compactions | 0 | 0 | 0 |
| Evaluation checks | 128/128 | 128/128 | 0 |

| Task | OpenCode | Cuppet | OpenCode time | Cuppet time | OpenCode input/cache | Cuppet input/cache | Compactions O/C |
|---|---|---|---:|---:|---:|---:|---:|
| landing-page | pass (15/15) | pass* (15/15) | 321360 ms | 520401 ms | 29117 / 242176 | 41139 / 478848 | 0 / 0 |
| todo-list-app | pass* (16/16) | pass (16/16) | 356265 ms | 274957 ms | 14686 / 672576 | 10359 / 470656 | 0 / 0 |
| calculator-web-app | pass (16/16) | pass (16/16) | 303646 ms | 346041 ms | 9985 / 396416 | 13361 / 581440 | 0 / 0 |
| survey-form | pass* (18/18) | pass* (18/18) | 475464 ms | 308665 ms | 20825 / 969088 | 11967 / 766912 | 0 / 0 |
| personal-blog | pass (15/15) | pass (15/15) | 393513 ms | 489497 ms | 19711 / 596416 | 20258 / 1373568 | 0 / 0 |
| business-portfolio | pass (15/15) | pass (15/15) | 474545 ms | 723406 ms | 23133 / 1419456 | 24202 / 2773248 | 0 / 0 |
| quiz-game | pass (17/17) | pass* (17/17) | 200862 ms | 359473 ms | 7648 / 609344 | 11380 / 1211328 | 0 / 0 |
| meme-generator | pass (16/16) | pass (16/16) | 483804 ms | 410115 ms | 19596 / 1620160 | 10129 / 1156544 | 0 / 0 |

Cache-read tokens are reported separately from uncached input. Reported cost is only meaningful if the provider returns a nonzero cost; token counts alone are not a price calculation.
* = recovered by the verification guard: after a failed attempt, the deterministic evaluator fed exact failed checks back to the same session (up to 2 repairs per task, both arms identically).
