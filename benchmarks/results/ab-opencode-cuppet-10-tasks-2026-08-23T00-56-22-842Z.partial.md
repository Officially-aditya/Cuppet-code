# OpenCode vs Cuppet: 1 sequential web project

- Status: partial
- Created: 2026-08-23T00:56:22.842Z
- Model: `opencode/x-preview-f-free`
- Cuppet context mode: `task-conditioned-relevance`
- Each arm used one persistent foreground session and received the same 1 prompt in the same order. Arms ran concurrently for each task so neither provider prompt cache is evicted by idle time.

| Aggregate metric | OpenCode | Cuppet | Candidate minus baseline |
|---|---:|---:|---:|
| Correct tasks | 1/1 | 1/1 | 0.00 |
| Agent time | 357011 ms | 374809 ms | -5.0% |
| End-to-end time | 357015 ms | 374817 ms | -5.0% |
| Uncached input tokens | 34434 | 47973 | -39.3% |
| Cache-read tokens | 232192 | 188416 | -43776 |
| Cache share | 87.1% | 79.7% | -7.4 pp |
| Cache share (idle-adjusted, ≤180s gaps) | 91.2% | 85.0% | -6.2 pp |
| Correct on first attempt | 1 | 0 | -1 |
| Repair-recovered tasks | 0 | 1 | 1 |
| Full cache-miss steps (excl. first) | 0 | 0 | 0 |
| Total model tokens | 49997 | 62297 | -24.6% |
| Compactions | 0 | 0 | 0 |
| Evaluation checks | 15/15 | 15/15 | 0 |

| Task | OpenCode | Cuppet | OpenCode time | Cuppet time | OpenCode input/cache | Cuppet input/cache | Compactions O/C |
|---|---|---|---:|---:|---:|---:|---:|
| landing-page | pass (15/15) | pass* (15/15) | 357011 ms | 374809 ms | 34434 / 232192 | 47973 / 188416 | 0 / 0 |

Cache-read tokens are reported separately from uncached input. Reported cost is only meaningful if the provider returns a nonzero cost; token counts alone are not a price calculation.
* = recovered by the verification guard: after a failed attempt, the deterministic evaluator fed exact failed checks back to the same session (up to 2 repairs per task, both arms identically).
