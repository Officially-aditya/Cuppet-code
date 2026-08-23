# OpenCode vs Cuppet: 8 sequential web projects

- Status: partial
- Created: 2026-08-22T20:43:51.552Z
- Model: `openai/gpt-5.6-luna`, variant: `low`
- Cuppet context mode: `standard`
- Each arm used one persistent foreground session and received the same 8 prompts in the same order. Arms were alternated between tasks.

| Aggregate metric | OpenCode | Cuppet | Candidate minus baseline |
|---|---:|---:|---:|
| Correct tasks | 7/8 | 8/8 | 0.13 |
| Agent time | 951556 ms | 1027886 ms | -8.0% |
| End-to-end time | 951921 ms | 1028239 ms | -8.0% |
| Uncached input tokens | 172788 | 127507 | 26.2% |
| Cache-read tokens | 2675712 | 3368960 | 693248 |
| Cache share | 93.9% | 96.4% | 2.4 pp |
| Total model tokens | 215823 | 174631 | 19.1% |
| Compactions | 0 | 0 | 0 |
| Evaluation checks | 127/128 | 128/128 | 1 |

| Task | OpenCode | Cuppet | OpenCode time | Cuppet time | OpenCode input/cache | Cuppet input/cache | Compactions O/C |
|---|---|---|---:|---:|---:|---:|---:|
| landing-page | pass (15/15) | pass (15/15) | 130704 ms | 262326 ms | 24536 / 122880 | 34892 / 247808 | 0 / 0 |
| todo-list-app | pass (16/16) | pass (16/16) | 100109 ms | 101084 ms | 27804 / 155648 | 12962 / 294912 | 0 / 0 |
| calculator-web-app | pass (16/16) | pass (16/16) | 89987 ms | 89486 ms | 10212 / 224768 | 10539 / 288768 | 0 / 0 |
| survey-form | pass (18/18) | pass (18/18) | 121829 ms | 126309 ms | 13338 / 275968 | 15944 / 438272 | 0 / 0 |
| personal-blog | pass (15/15) | pass (15/15) | 126619 ms | 114979 ms | 13231 / 348672 | 12204 / 420864 | 0 / 0 |
| business-portfolio | fail (14/15) | pass (15/15) | 168191 ms | 129776 ms | 60106 / 438784 | 14964 / 485376 | 0 / 0 |
| quiz-game | pass (17/17) | pass (17/17) | 104613 ms | 102484 ms | 11214 / 523776 | 13748 / 563200 | 0 / 0 |
| meme-generator | pass (16/16) | pass (16/16) | 109504 ms | 101442 ms | 12347 / 585216 | 12254 / 629760 | 0 / 0 |

Cache-read tokens are reported separately from uncached input. Reported cost is only meaningful if the provider returns a nonzero cost; token counts alone are not a price calculation.
