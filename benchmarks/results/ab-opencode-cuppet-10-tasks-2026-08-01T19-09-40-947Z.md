# OpenCode vs Cuppet: ten sequential web projects

- Status: completed
- Created: 2026-08-01T19:09:40.947Z
- Model: `openai/gpt-5.6-luna`, variant: `low`
- Each arm used one persistent foreground session and received the same ten prompts in the same order. Arms were alternated between tasks.

| Aggregate metric | OpenCode | Cuppet | Candidate minus baseline |
|---|---:|---:|---:|
| Correct tasks | 8/10 | 10/10 | 0.20 |
| Agent time | 1483652 ms | 1440752 ms | 2.9% |
| End-to-end time | 1484070 ms | 1441179 ms | 2.9% |
| Uncached input tokens | 178438 | 1443523 | -709.0% |
| Cache-read tokens | 5916160 | 1387008 | -4529152 |
| Cache share | 97.1% | 49.0% | -48.1 pp |
| Total model tokens | 246486 | 1512466 | -513.6% |
| Compactions | 0 | 0 | 0 |
| Evaluation checks | 161/163 | 163/163 | 2 |

| Task | OpenCode | Cuppet | OpenCode time | Cuppet time | OpenCode input/cache | Cuppet input/cache | Compactions O/C |
|---|---|---|---:|---:|---:|---:|---:|
| landing-page | pass (15/15) | pass (15/15) | 158413 ms | 151327 ms | 26497 / 132096 | 60257 / 105472 | 0 / 0 |
| todo-list-app | pass (16/16) | pass (16/16) | 109460 ms | 88921 ms | 10679 / 196096 | 37168 / 102400 | 0 / 0 |
| calculator-web-app | pass (16/16) | pass (16/16) | 99100 ms | 99774 ms | 12344 / 249344 | 66389 / 155136 | 0 / 0 |
| survey-form | pass (18/18) | pass (18/18) | 134302 ms | 126811 ms | 15229 / 310784 | 66436 / 144896 | 0 / 0 |
| personal-blog | pass (15/15) | pass (15/15) | 222466 ms | 138839 ms | 29488 / 942592 | 180079 / 152576 | 0 / 0 |
| business-portfolio | fail (14/15) | pass (15/15) | 163009 ms | 217739 ms | 19055 / 569856 | 210076 / 211968 | 0 / 0 |
| quiz-game | pass (17/17) | pass (17/17) | 143963 ms | 139827 ms | 15824 / 774144 | 153378 / 177152 | 0 / 0 |
| meme-generator | fail (15/16) | pass (16/16) | 133107 ms | 110001 ms | 14502 / 784896 | 180460 / 105984 | 0 / 0 |
| address-book | pass (17/17) | pass (17/17) | 138696 ms | 137393 ms | 15952 / 869888 | 144561 / 86528 | 0 / 0 |
| e-library | pass (18/18) | pass (18/18) | 181136 ms | 230120 ms | 18868 / 1086464 | 344719 / 144896 | 0 / 0 |

Cache-read tokens are reported separately from uncached input. Reported cost is only meaningful if the provider returns a nonzero cost; token counts alone are not a price calculation.
