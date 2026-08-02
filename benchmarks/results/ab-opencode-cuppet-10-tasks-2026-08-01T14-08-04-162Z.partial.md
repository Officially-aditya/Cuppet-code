# OpenCode vs Cuppet: ten sequential web projects

- Status: partial
- Created: 2026-08-01T14:08:04.163Z
- Model: `openai/gpt-5.6-luna`, variant: `low`
- Each arm used one persistent foreground session and received the same ten prompts in the same order. Arms were alternated between tasks.

| Aggregate metric | OpenCode | Cuppet | Candidate minus baseline |
|---|---:|---:|---:|
| Correct tasks | 9/10 | 7/10 | -0.20 |
| Agent time | 1482294 ms | 1181185 ms | 20.3% |
| End-to-end time | 1482710 ms | 1181596 ms | 20.3% |
| Uncached input tokens | 172463 | 3209828 | -1761.2% |
| Cache-read tokens | 5145600 | 1089536 | -4056064 |
| Cache share | 96.8% | 25.3% | -71.4 pp |
| Total model tokens | 237298 | 3259097 | -1273.4% |
| Compactions | 0 | 0 | 0 |
| Evaluation checks | 162/163 | 160/163 | -2 |

| Task | OpenCode | Cuppet | OpenCode time | Cuppet time | OpenCode input/cache | Cuppet input/cache | Compactions O/C |
|---|---|---|---:|---:|---:|---:|---:|
| landing-page | pass (15/15) | pass (15/15) | 178727 ms | 183234 ms | 25475 / 130048 | 31008 / 193024 | 0 / 0 |
| todo-list-app | pass (16/16) | pass (16/16) | 98876 ms | 103761 ms | 12411 / 162816 | 47766 / 193024 | 0 / 0 |
| calculator-web-app | pass (16/16) | pass (16/16) | 100682 ms | 110477 ms | 11693 / 219136 | 219153 / 87552 | 0 / 0 |
| survey-form | pass (18/18) | pass (18/18) | 122051 ms | 142421 ms | 12805 / 275456 | 290145 / 168448 | 0 / 0 |
| personal-blog | pass (15/15) | pass (15/15) | 151287 ms | 142422 ms | 16103 / 392704 | 318088 / 77824 | 0 / 0 |
| business-portfolio | pass (15/15) | fail (14/15) | 175091 ms | 108704 ms | 19738 / 498176 | 377674 / 77824 | 0 / 0 |
| quiz-game | pass (17/17) | pass (17/17) | 142762 ms | 83292 ms | 17489 / 687104 | 380722 / 68096 | 0 / 0 |
| meme-generator | fail (15/16) | fail (15/16) | 175546 ms | 76051 ms | 19116 / 887296 | 417879 / 68096 | 0 / 0 |
| address-book | pass (17/17) | pass (17/17) | 157721 ms | 139002 ms | 18894 / 934912 | 604998 / 87552 | 0 / 0 |
| e-library | pass (18/18) | fail (17/18) | 179551 ms | 91821 ms | 18739 / 957952 | 522395 / 68096 | 0 / 0 |

Cache-read tokens are reported separately from uncached input. Reported cost is only meaningful if the provider returns a nonzero cost; token counts alone are not a price calculation.
