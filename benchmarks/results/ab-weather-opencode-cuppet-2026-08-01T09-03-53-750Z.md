# OpenCode vs Cuppet weather-app trial

- Created: 2026-08-01T09:03:53.749Z
- Model: `openai/gpt-5.6-luna`, reasoning effort/variant: `low`
- Each arm used a fresh minimal Git workspace and the same task prompt.

| Metric | OpenCode | Cuppet | Candidate minus baseline |
|---|---:|---:|---:|
| Successes | 1/1 | 0/1 | -1.00 |
| Median agent time | 101728 ms | 11239 ms | 89.0% |
| Median end-to-end time | 102804 ms | 11244 ms | 89.1% |
| Median input tokens | 22971 | 0 | 100.0% |
| Median total model tokens | 26897 | 0 | 100.0% |
| Compaction trials | 0/1 | 0/1 | tracked automatically |
| Median injected context | 0 | 0 | cuppet-side overhead |
| Mean acceptance | 100.0% | 11.1% | -88.9 pp |

## Trial details

- opencode: success; acceptance 9/9; 101728 ms agent time; 102804 ms end-to-end; 26897 model tokens; compaction no (0)
- cuppet: failure; acceptance 1/9; 11239 ms agent time; 11244 ms end-to-end; 0 model tokens; compaction no (0)

This is one small paired task unless repeats are increased; treat the result as directional, not a general model ranking.
