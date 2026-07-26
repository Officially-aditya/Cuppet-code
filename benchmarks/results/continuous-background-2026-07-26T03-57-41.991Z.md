# Continuous background-worker token benchmark

- Created: 2026-07-26T03:57:41.990Z
- Foreground model: `openai/gpt-5.6-luna@high`; background model: `openai/gpt-5.6-luna@low`.
- Both arms use the same three read-only foreground turns. The active arm starts later foreground turns while the preceding background canonicalization is running.

## Results

| Metric | Background paused | Background active |
|---|---:|---:|
| Correct foreground turns | 3/3 | 3/3 |
| Foreground model tokens | 20839 | 20371 |
| Background model tokens | 0 | 7416 |
| Active total model tokens | 20839 | 27787 |
| Active initialization background tokens | — | 2365 |
| Active continuous background tokens | — | 5051 |
| Completed / failed background jobs | — | 4 / 0 |
| Foreground turns overlapping a running background job | 0 | 2 |

Total model-token increase with background active: 6948. Reported provider costs are retained in the raw JSON; zero-valued telemetry is not treated as free usage.

## Per-turn foreground usage

- paused/context-builder: correct; 16196 foreground tokens; 7864 ms; background running at start: no.
- paused/allocator: correct; 1980 foreground tokens; 2648 ms; background running at start: no.
- paused/graph-renderer: correct; 2663 foreground tokens; 2889 ms; background running at start: no.
- active/context-builder: correct; 16332 foreground tokens; 8537 ms; background running at start: no.
- active/allocator: correct; 2151 foreground tokens; 3687 ms; background running at start: yes.
- active/graph-renderer: correct; 1888 foreground tokens; 1941 ms; background running at start: yes.
