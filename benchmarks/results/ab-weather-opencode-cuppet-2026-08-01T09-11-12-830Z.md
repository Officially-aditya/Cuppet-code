# OpenCode vs Cuppet weather-app trial

- Created: 2026-08-01T09:11:12.829Z
- Model: `openai/gpt-5.6-luna`, reasoning effort/variant: `low`
- Each arm used a fresh minimal Git workspace and the same task prompt.

| Metric | OpenCode | Cuppet | Candidate minus baseline |
|---|---:|---:|---:|
| Successes | 1/1 | 1/1 | 0.00 |
| Median agent time | 95629 ms | 90430 ms | 5.4% |
| Median end-to-end time | 96712 ms | 94505 ms | 2.3% |
| Median input tokens | 22992 | 26326 | -14.5% |
| Median total model tokens | 27002 | 30066 | -11.3% |
| Compaction trials | 0/1 | 0/1 | tracked automatically |
| Median injected context | 0 | 0 | cuppet-side overhead |
| Mean acceptance | 100.0% | 100.0% | 0.0 pp |

## Trial details

- opencode: success; acceptance 9/9; 95629 ms agent time; 96712 ms end-to-end; 27002 model tokens; compaction no (0)
- cuppet: success; acceptance 9/9; 90430 ms agent time; 94505 ms end-to-end; 30066 model tokens; compaction no (0)

This is one small paired task unless repeats are increased; treat the result as directional, not a general model ranking.
