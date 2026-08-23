# OpenCode vs Cuppet: 8 sequential web projects

- Status: completed
- Created: 2026-08-22T20:06:53.115Z
- Model: `openai/gpt-5.6-luna`, variant: `low`
- Cuppet context mode: `standard`
- Each arm used one persistent foreground session and received the same 8 prompts in the same order. Arms were alternated between tasks.

| Aggregate metric | OpenCode | Cuppet | Candidate minus baseline |
|---|---:|---:|---:|
| Correct tasks | 8/8 | 6/8 | -0.25 |
| Agent time | 1046130 ms | 859659 ms | 17.8% |
| End-to-end time | 1046655 ms | 860171 ms | 17.8% |
| Uncached input tokens | 128070 | 272359 | -112.7% |
| Cache-read tokens | 3302400 | 2838528 | -463872 |
| Cache share | 96.3% | 91.2% | -5.0 pp |
| Total model tokens | 172068 | 309200 | -79.7% |
| Compactions | 0 | 0 | 0 |
| Evaluation checks | 128/128 | 126/128 | -2 |

| Task | OpenCode | Cuppet | OpenCode time | Cuppet time | OpenCode input/cache | Cuppet input/cache | Compactions O/C |
|---|---|---|---:|---:|---:|---:|---:|
| landing-page | pass (15/15) | pass (15/15) | 131132 ms | 134575 ms | 25682 / 141824 | 29892 / 152576 | 0 / 0 |
| todo-list-app | pass (16/16) | pass (16/16) | 116750 ms | 96875 ms | 14199 / 194560 | 12559 / 214016 | 0 / 0 |
| calculator-web-app | pass (16/16) | pass (16/16) | 103067 ms | 78105 ms | 13617 / 293376 | 41784 / 211968 | 0 / 0 |
| survey-form | pass (18/18) | pass (18/18) | 124222 ms | 99881 ms | 13902 / 332800 | 14772 / 293376 | 0 / 0 |
| personal-blog | pass (15/15) | pass (15/15) | 127933 ms | 138401 ms | 14852 / 412672 | 66100 / 499200 | 0 / 0 |
| business-portfolio | pass (15/15) | fail (14/15) | 144784 ms | 124424 ms | 15122 / 503808 | 14467 / 445952 | 0 / 0 |
| quiz-game | pass (17/17) | pass (17/17) | 147253 ms | 94381 ms | 16162 / 662016 | 82371 / 447488 | 0 / 0 |
| meme-generator | pass (16/16) | fail (15/16) | 150989 ms | 93017 ms | 14534 / 761344 | 10414 / 573952 | 0 / 0 |

Cache-read tokens are reported separately from uncached input. Reported cost is only meaningful if the provider returns a nonzero cost; token counts alone are not a price calculation.
