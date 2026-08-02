# OpenCode vs Cuppet: ten sequential web projects

- Status: partial
- Created: 2026-08-01T16:05:05.702Z
- Model: `openai/gpt-5.6-luna`, variant: `low`
- Each arm used one persistent foreground session and received the same ten prompts in the same order. Arms were alternated between tasks.

| Aggregate metric | OpenCode | Cuppet | Candidate minus baseline |
|---|---:|---:|---:|
| Correct tasks | 9/10 | 9/10 | 0.00 |
| Agent time | 1520236 ms | 1348788 ms | 11.3% |
| End-to-end time | 1520668 ms | 1349205 ms | 11.3% |
| Uncached input tokens | 169484 | 153427 | 9.5% |
| Cache-read tokens | 6085120 | 4690944 | -1394176 |
| Cache share | 97.3% | 96.8% | -0.5 pp |
| Total model tokens | 232714 | 209013 | 10.2% |
| Compactions | 0 | 0 | 0 |
| Evaluation checks | 161/163 | 162/163 | 1 |

| Task | OpenCode | Cuppet | OpenCode time | Cuppet time | OpenCode input/cache | Cuppet input/cache | Compactions O/C |
|---|---|---|---:|---:|---:|---:|---:|
| landing-page | pass (15/15) | pass (15/15) | 178364 ms | 140287 ms | 30129 / 229376 | 24344 / 130048 | 0 / 0 |
| todo-list-app | pass (16/16) | pass (16/16) | 117914 ms | 106320 ms | 12721 / 250368 | 14023 / 183808 | 0 / 0 |
| calculator-web-app | pass (16/16) | pass (16/16) | 116330 ms | 115430 ms | 10464 / 325120 | 10199 / 263680 | 0 / 0 |
| survey-form | pass (18/18) | pass (18/18) | 129973 ms | 153232 ms | 13213 / 438272 | 17158 / 408064 | 0 / 0 |
| personal-blog | fail (13/15) | pass (15/15) | 142969 ms | 156781 ms | 13635 / 441344 | 16437 / 421376 | 0 / 0 |
| business-portfolio | pass (15/15) | pass (15/15) | 216379 ms | 143378 ms | 27171 / 675840 | 15346 / 521728 | 0 / 0 |
| quiz-game | pass (17/17) | pass (17/17) | 150727 ms | 121247 ms | 15165 / 817664 | 12492 / 535552 | 0 / 0 |
| meme-generator | pass (16/16) | fail (15/16) | 130472 ms | 109683 ms | 14213 / 907776 | 12075 / 590848 | 0 / 0 |
| address-book | pass (17/17) | pass (17/17) | 152717 ms | 161773 ms | 13462 / 902144 | 16975 / 818176 | 0 / 0 |
| e-library | pass (18/18) | pass (18/18) | 184391 ms | 140657 ms | 19311 / 1097216 | 14378 / 817664 | 0 / 0 |

Cache-read tokens are reported separately from uncached input. Reported cost is only meaningful if the provider returns a nonzero cost; token counts alone are not a price calculation.
