# OpenCode vs Cuppet: 8 sequential web projects

- Status: completed
- Created: 2026-08-22T23:54:00.085Z
- Model: `openai/gpt-5.6-luna`, variant: `low`
- Cuppet context mode: `task-conditioned-relevance`
- Each arm used one persistent foreground session and received the same 8 prompts in the same order. Arms ran concurrently for each task so neither provider prompt cache is evicted by idle time.

| Aggregate metric | OpenCode | Cuppet | Candidate minus baseline |
|---|---:|---:|---:|
| Correct tasks | 8/8 | 8/8 | 0.00 |
| Agent time | 973192 ms | 901440 ms | 7.4% |
| End-to-end time | 974325 ms | 902019 ms | 7.4% |
| Uncached input tokens | 119025 | 105721 | 11.2% |
| Cache-read tokens | 2851840 | 2332672 | -519168 |
| Cache share | 96.0% | 95.7% | -0.3 pp |
| Cache share (idle-adjusted, ≤180s gaps) | 96.3% | 96.1% | -0.2 pp |
| Correct on first attempt | 8 | 8 | 0 |
| Repair-recovered tasks | 0 | 0 | 0 |
| Full cache-miss steps (excl. first) | 0 | 0 | 0 |
| Total model tokens | 163131 | 147945 | 9.3% |
| Compactions | 0 | 0 | 0 |
| Evaluation checks | 128/128 | 128/128 | 0 |

| Task | OpenCode | Cuppet | OpenCode time | Cuppet time | OpenCode input/cache | Cuppet input/cache | Compactions O/C |
|---|---|---|---:|---:|---:|---:|---:|
| landing-page | pass (15/15) | pass (15/15) | 121032 ms | 107548 ms | 24441 / 122880 | 21794 / 64000 | 0 / 0 |
| todo-list-app | pass (16/16) | pass (16/16) | 99188 ms | 97181 ms | 11835 / 173568 | 8803 / 125952 | 0 / 0 |
| calculator-web-app | pass (16/16) | pass (16/16) | 100826 ms | 105321 ms | 9231 / 230912 | 11784 / 278528 | 0 / 0 |
| survey-form | pass (18/18) | pass (18/18) | 117633 ms | 107306 ms | 13701 / 318464 | 11407 / 272384 | 0 / 0 |
| personal-blog | pass (15/15) | pass (15/15) | 132194 ms | 132367 ms | 13095 / 360960 | 12395 / 289280 | 0 / 0 |
| business-portfolio | pass (15/15) | pass (15/15) | 162080 ms | 131185 ms | 21716 / 506880 | 14303 / 296960 | 0 / 0 |
| quiz-game | pass (17/17) | pass (17/17) | 131869 ms | 107197 ms | 13355 / 568832 | 12342 / 476160 | 0 / 0 |
| meme-generator | pass (16/16) | pass (16/16) | 108370 ms | 113335 ms | 11651 / 569344 | 12893 / 529408 | 0 / 0 |

Cache-read tokens are reported separately from uncached input. Reported cost is only meaningful if the provider returns a nonzero cost; token counts alone are not a price calculation.
* = recovered by the verification guard: after a failed attempt, the deterministic evaluator fed exact failed checks back to the same session (up to 2 repairs per task, both arms identically).
