# OpenCode vs Cuppet: ten sequential web projects

- Status: partial
- Created: 2026-08-01T14:59:20.232Z
- Model: `openai/gpt-5.6-luna`, variant: `low`
- Each arm used one persistent foreground session and received the same ten prompts in the same order. Arms were alternated between tasks.

| Aggregate metric | OpenCode | Cuppet | Candidate minus baseline |
|---|---:|---:|---:|
| Correct tasks | 9/10 | 8/10 | -0.10 |
| Agent time | 2136215 ms | 1441310 ms | 32.5% |
| End-to-end time | 2136651 ms | 1441737 ms | 32.5% |
| Uncached input tokens | 178151 | 913017 | -412.5% |
| Cache-read tokens | 5882880 | 3638784 | -2244096 |
| Cache share | 97.1% | 79.9% | -17.1 pp |
| Total model tokens | 249070 | 968408 | -288.8% |
| Compactions | 0 | 0 | 0 |
| Evaluation checks | 162/163 | 161/163 | -1 |

| Task | OpenCode | Cuppet | OpenCode time | Cuppet time | OpenCode input/cache | Cuppet input/cache | Compactions O/C |
|---|---|---|---:|---:|---:|---:|---:|
| landing-page | pass (15/15) | pass (15/15) | 323469 ms | 170063 ms | 39411 / 327680 | 25173 / 154112 | 0 / 0 |
| todo-list-app | pass (16/16) | pass (16/16) | 121830 ms | 110959 ms | 13545 / 299008 | 15133 / 194048 | 0 / 0 |
| calculator-web-app | pass (16/16) | pass (16/16) | 105248 ms | 100804 ms | 11977 / 291840 | 48079 / 229888 | 0 / 0 |
| survey-form | pass (18/18) | pass (18/18) | 140654 ms | 123350 ms | 14623 / 397824 | 61146 / 276992 | 0 / 0 |
| personal-blog | pass (15/15) | pass (15/15) | 177753 ms | 138276 ms | 18428 / 659456 | 76602 / 338432 | 0 / 0 |
| business-portfolio | fail (14/15) | fail (14/15) | 193630 ms | 146880 ms | 16341 / 598528 | 59839 / 483328 | 0 / 0 |
| quiz-game | pass (17/17) | pass (17/17) | 130330 ms | 109799 ms | 15212 / 697856 | 159266 / 398848 | 0 / 0 |
| meme-generator | pass (16/16) | fail (15/16) | 217883 ms | 101984 ms | 15375 / 776704 | 181847 / 367616 | 0 / 0 |
| address-book | pass (17/17) | pass (17/17) | 497535 ms | 233316 ms | 16435 / 865792 | 202722 / 624128 | 0 / 0 |
| e-library | pass (18/18) | pass (18/18) | 227883 ms | 205879 ms | 16804 / 968192 | 83210 / 571392 | 0 / 0 |

Cache-read tokens are reported separately from uncached input. Reported cost is only meaningful if the provider returns a nonzero cost; token counts alone are not a price calculation.
