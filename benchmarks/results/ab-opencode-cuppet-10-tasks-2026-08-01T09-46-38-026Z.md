# OpenCode vs Cuppet: ten sequential web projects

- Status: completed
- Created: 2026-08-01T09:46:38.027Z
- Model: `openai/gpt-5.6-luna`, variant: `low`
- Each arm used one persistent foreground session and received the same ten prompts in the same order. Arms were alternated between tasks.

| Aggregate metric | OpenCode | Cuppet | Candidate minus baseline |
|---|---:|---:|---:|
| Correct tasks | 9/10 | 9/10 | 0.00 |
| Agent time | 1280729 ms | 1097888 ms | 14.3% |
| End-to-end time | 1281160 ms | 1098323 ms | 14.3% |
| Uncached input tokens | 158940 | 1043998 | -556.9% |
| Cache-read tokens | 4069376 | 3163136 | -906240 |
| Cache share | 96.2% | 75.2% | -21.1 pp |
| Total model tokens | 215039 | 1091707 | -407.7% |
| Compactions | 0 | 0 | 0 |
| Evaluation checks | 162/163 | 162/163 | 0 |

| Task | OpenCode | Cuppet | OpenCode time | Cuppet time | OpenCode input/cache | Cuppet input/cache | Compactions O/C |
|---|---|---|---:|---:|---:|---:|---:|
| landing-page | pass (15/15) | pass (15/15) | 150704 ms | 124120 ms | 23077 / 124928 | 24147 / 103424 | 0 / 0 |
| todo-list-app | pass (16/16) | pass (16/16) | 99330 ms | 107799 ms | 27070 / 149504 | 22631 / 242176 | 0 / 0 |
| calculator-web-app | pass (16/16) | pass (16/16) | 88926 ms | 90623 ms | 11365 / 213504 | 40013 / 240128 | 0 / 0 |
| survey-form | pass (18/18) | pass (18/18) | 115958 ms | 125580 ms | 12744 / 261632 | 95295 / 299008 | 0 / 0 |
| personal-blog | pass (15/15) | pass (15/15) | 125660 ms | 103603 ms | 14043 / 323072 | 46825 / 330752 | 0 / 0 |
| business-portfolio | fail (14/15) | fail (14/15) | 155626 ms | 141799 ms | 16916 / 447488 | 140311 / 378368 | 0 / 0 |
| quiz-game | pass (17/17) | pass (17/17) | 116761 ms | 103042 ms | 12100 / 485888 | 173284 / 290304 | 0 / 0 |
| meme-generator | pass (16/16) | pass (16/16) | 111824 ms | 90774 ms | 12176 / 610304 | 196067 / 392192 | 0 / 0 |
| address-book | pass (17/17) | pass (17/17) | 156326 ms | 102878 ms | 14452 / 758272 | 217723 / 349696 | 0 / 0 |
| e-library | pass (18/18) | pass (18/18) | 159614 ms | 107670 ms | 14997 / 694784 | 87702 / 537088 | 0 / 0 |

Cache-read tokens are reported separately from uncached input. Reported cost is only meaningful if the provider returns a nonzero cost; token counts alone are not a price calculation.
