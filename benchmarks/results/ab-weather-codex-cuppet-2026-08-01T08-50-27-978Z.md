# Codex vs Cuppet weather-app trial

- Created: 2026-08-01T08:50:27.802Z
- Model: `openai/gpt-5.6-luna`, reasoning effort/variant: `low`
- Each arm used a fresh minimal Git workspace and the same task prompt.

| Metric | Codex | Cuppet | Difference |
|---|---:|---:|---:|
| Successes | 1/1 | 1/1 | 0.00 |
| Median agent time | 80053 ms | 109241 ms | -36.5% |
| Median end-to-end time | 81642 ms | 113492 ms | -39.0% |
| Median input tokens | 111500 | 27739 | 75.1% |
| Median total model tokens | 115345 | 31993 | 72.3% |
| Compaction trials | 0/1 | 0/1 | tracked automatically |
| Median injected context | 0 | 0 | Cuppet-only overhead |
| Mean acceptance | 100.0% | 100.0% | 0.0 pp |

## Trial details

- codex: success; acceptance 9/9; 80053 ms agent time; 81642 ms end-to-end; 115345 model tokens; compaction no (0)
- cuppet: success; acceptance 9/9; 109241 ms agent time; 113492 ms end-to-end; 31993 model tokens; compaction no (0)

This is one small paired task unless repeats are increased; treat the result as directional, not a general model ranking.
