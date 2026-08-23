# OpenCode vs Cuppet: 8 sequential web projects

- Status: completed
- Created: 2026-08-22T21:48:29.217Z
- Model: `openai/gpt-5.6-luna`, variant: `low`
- Cuppet context mode: `standard`
- Each arm used one persistent foreground session and received the same 8 prompts in the same order. Arms ran concurrently for each task so neither provider prompt cache is evicted by idle time.

| Aggregate metric | OpenCode | Cuppet | Candidate minus baseline |
|---|---:|---:|---:|
| Correct tasks | 6/8 | 7/8 | 0.13 |
| Agent time | 1527490 ms | 1332390 ms | 12.8% |
| End-to-end time | 1527840 ms | 1332710 ms | 12.8% |
| Uncached input tokens | 210846 | 147323 | 30.1% |
| Cache-read tokens | 3209216 | 1788928 | -1420288 |
| Cache share | 93.8% | 92.4% | -1.4 pp |
| Cache share (idle-adjusted, ≤180s gaps) | 94.0% | 92.6% | -1.4 pp |
| Full cache-miss steps (excl. first) | 2 | 1 | -1 |
| Total model tokens | 260660 | 183519 | 29.6% |
| Compactions | 0 | 0 | 0 |
| Evaluation checks | 126/128 | 127/128 | 1 |

| Task | OpenCode | Cuppet | OpenCode time | Cuppet time | OpenCode input/cache | Cuppet input/cache | Compactions O/C |
|---|---|---|---:|---:|---:|---:|---:|
| landing-page | pass (15/15) | pass (15/15) | 169092 ms | 136293 ms | 27198 / 173056 | 26928 / 135168 | 0 / 0 |
| todo-list-app | pass (16/16) | pass (16/16) | 116147 ms | 80596 ms | 33134 / 203264 | 8130 / 107008 | 0 / 0 |
| calculator-web-app | pass (16/16) | pass (16/16) | 91674 ms | 72240 ms | 17534 / 252416 | 7358 / 167936 | 0 / 0 |
| survey-form | pass (18/18) | pass (18/18) | 130045 ms | 103390 ms | 14370 / 354304 | 9581 / 200704 | 0 / 0 |
| personal-blog | fail (14/15) | pass (15/15) | 160894 ms | 133862 ms | 17041 / 447488 | 16371 / 473600 | 0 / 0 |
| business-portfolio | fail (14/15) | pass (15/15) | 452879 ms | 446042 ms | 75064 / 450560 | 60241 / 151040 | 0 / 0 |
| quiz-game | pass (17/17) | pass (17/17) | 282195 ms | 291215 ms | 13664 / 625152 | 10618 / 292352 | 0 / 0 |
| meme-generator | pass (16/16) | fail (15/16) | 124564 ms | 68752 ms | 12841 / 702976 | 8096 / 261120 | 0 / 0 |

Cache-read tokens are reported separately from uncached input. Reported cost is only meaningful if the provider returns a nonzero cost; token counts alone are not a price calculation.
