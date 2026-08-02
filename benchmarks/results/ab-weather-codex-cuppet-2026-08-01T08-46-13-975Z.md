# Codex vs Cuppet weather-app trial

- Created: 2026-08-01T08:46:13.797Z
- Model: `openai/gpt-5.6-luna`, reasoning effort/variant: `low`
- Each arm used a fresh minimal Git workspace and the same task prompt.

| Metric | Codex | Cuppet | Difference |
|---|---:|---:|---:|
| Successes | 0/1 | 1/1 | 1.00 |
| Median agent time | 251 ms | 93235 ms | -37045.4% |
| Median end-to-end time | 1342 ms | 116350 ms | -8569.9% |
| Median input tokens | 0 | 29201 | 0.0% |
| Median total model tokens | 0 | 32960 | 0.0% |
| Compaction trials | 0/1 | 0/1 | tracked automatically |
| Median injected context | 0 | 0 | Cuppet-only overhead |
| Mean acceptance | 11.1% | 100.0% | 88.9 pp |

## Trial details

- codex: failure; acceptance 1/9; 251 ms agent time; 1342 ms end-to-end; 0 model tokens; compaction no (0)
- cuppet: success; acceptance 9/9; 93235 ms agent time; 116350 ms end-to-end; 32960 model tokens; compaction no (0)

This is one small paired task unless repeats are increased; treat the result as directional, not a general model ranking.
