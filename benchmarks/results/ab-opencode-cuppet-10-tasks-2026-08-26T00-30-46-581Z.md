# Three-arm sequential web benchmark: 10 projects

- Status: completed
- Created: 2026-08-26T00:30:46.581Z
- Model: `openai/gpt-5.6-luna`, variant: `low`
- Cuppet context mode: `task-conditioned-relevance`
- Each arm used one persistent session and received the same 10 prompts in the same order. Arms ran concurrently for each task so provider prompt caches remain comparable.

| Aggregate metric | OpenCode | Cuppet | DeepSeek Harness |
|---|---:|---:|---:|
| Correct tasks | 10/10 | 10/10 | 10/10 |
| Agent time | 1464489 ms | 1833176 ms | 4252203 ms |
| End-to-end time | 1464970 ms | 1833819 ms | 4252203 ms |
| Uncached input tokens | 628051 | 149018 | 594674 |
| Cache-read tokens | 4434944 | 3445760 | 12791808 |
| Cache share | 87.6% | 95.9% | 95.6% |
| Cache share (idle-adjusted, ≤180s gaps) | 87.8% | 96.1% | 0.0% |
| Correct on first attempt | 10 | 10 | 9 |
| Repair-recovered tasks | 0 | 0 | 1 |
| Total model tokens | 687688 | 200771 | 780625 |
| Compactions | 0 | 0 | 0 |
| Evaluation checks | 163/163 | 163/163 | 163/163 |

| Task | OpenCode | Cuppet | DeepSeek Harness |
|---|---|---|---|
| landing-page | pass (15/15) · 179698 ms · tok 40391 | pass (15/15) · 161849 ms · tok 29888 | pass (15/15) · 558626 ms · tok 79215 |
| todo-list-app | pass (16/16) · 110878 ms · tok 34343 | pass (16/16) · 103836 ms · tok 36420 | pass (16/16) · 474613 ms · tok 99282 |
| calculator-web-app | pass (16/16) · 158738 ms · tok 39543 | pass (16/16) · 151359 ms · tok 14811 | pass* (16/16) · 455554 ms · tok 45009 |
| survey-form | pass (18/18) · 129171 ms · tok 52173 | pass (18/18) · 116969 ms · tok 16891 | pass (18/18) · 428343 ms · tok 58119 |
| personal-blog | pass (15/15) · 168891 ms · tok 62264 | pass (15/15) · 182074 ms · tok 16675 | pass (15/15) · 383357 ms · tok 216848 |
| business-portfolio | pass (15/15) · 154375 ms · tok 75530 | pass (15/15) · 215425 ms · tok 19892 | pass (15/15) · 459758 ms · tok 58824 |
| quiz-game | pass (17/17) · 122645 ms · tok 80617 | pass (17/17) · 206630 ms · tok 14961 | pass (17/17) · 304654 ms · tok 86383 |
| meme-generator | pass (16/16) · 126614 ms · tok 89098 | pass (16/16) · 188590 ms · tok 14200 | pass (16/16) · 324550 ms · tok 40041 |
| address-book | pass (17/17) · 154633 ms · tok 102361 | pass (17/17) · 259047 ms · tok 17876 | pass (17/17) · 444901 ms · tok 50915 |
| e-library | pass (18/18) · 158846 ms · tok 111368 | pass (18/18) · 247397 ms · tok 19157 | pass (18/18) · 417847 ms · tok 45989 |

Cache-read tokens are reported separately from uncached input. Reported cost is meaningful only when the provider returns a nonzero cost.
* = recovered by the verification guard; pairwise reductions are in summary.comparisons.
