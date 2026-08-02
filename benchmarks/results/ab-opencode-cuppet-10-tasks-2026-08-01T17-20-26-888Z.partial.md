# OpenCode vs Cuppet: ten sequential web projects

- Status: partial
- Created: 2026-08-01T17:20:26.889Z
- Model: `openai/gpt-5.6-luna`, variant: `low`
- Each arm used one persistent foreground session and received the same ten prompts in the same order. Arms were alternated between tasks.

| Aggregate metric | OpenCode | Cuppet | Candidate minus baseline |
|---|---:|---:|---:|
| Correct tasks | 8/10 | 9/10 | 0.10 |
| Agent time | 1274340 ms | 1318010 ms | -3.4% |
| End-to-end time | 1274781 ms | 1318437 ms | -3.4% |
| Uncached input tokens | 170627 | 162479 | 4.8% |
| Cache-read tokens | 3652608 | 5169664 | 1517056 |
| Cache share | 95.5% | 97.0% | 1.4 pp |
| Total model tokens | 226205 | 217794 | 3.7% |
| Compactions | 0 | 0 | 0 |
| Evaluation checks | 161/163 | 162/163 | 1 |

| Task | OpenCode | Cuppet | OpenCode time | Cuppet time | OpenCode input/cache | Cuppet input/cache | Compactions O/C |
|---|---|---|---:|---:|---:|---:|---:|
| landing-page | pass (15/15) | pass (15/15) | 141078 ms | 147932 ms | 40754 / 133632 | 24871 / 125952 | 0 / 0 |
| todo-list-app | pass (16/16) | pass (16/16) | 112642 ms | 133049 ms | 11963 / 165376 | 13723 / 204800 | 0 / 0 |
| calculator-web-app | pass (16/16) | pass (16/16) | 94236 ms | 99596 ms | 9541 / 215552 | 11661 / 273408 | 0 / 0 |
| survey-form | pass (18/18) | pass (18/18) | 131965 ms | 121405 ms | 12831 / 295936 | 15144 / 342016 | 0 / 0 |
| personal-blog | pass (15/15) | pass (15/15) | 129803 ms | 157126 ms | 35752 / 299520 | 18997 / 486912 | 0 / 0 |
| business-portfolio | fail (14/15) | pass (15/15) | 137346 ms | 151032 ms | 12948 / 383488 | 17651 / 559104 | 0 / 0 |
| quiz-game | pass (17/17) | pass (17/17) | 120248 ms | 118184 ms | 10477 / 443904 | 15032 / 665600 | 0 / 0 |
| meme-generator | fail (15/16) | fail (15/16) | 116938 ms | 114855 ms | 11313 / 494080 | 11762 / 671232 | 0 / 0 |
| address-book | pass (17/17) | pass (17/17) | 141212 ms | 132304 ms | 12857 / 610304 | 16354 / 914944 | 0 / 0 |
| e-library | pass (18/18) | pass (18/18) | 148872 ms | 142527 ms | 12191 / 610816 | 17284 / 925696 | 0 / 0 |

Cache-read tokens are reported separately from uncached input. Reported cost is only meaningful if the provider returns a nonzero cost; token counts alone are not a price calculation.
