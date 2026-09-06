# Cuppet marathon benchmark — repetition 1

- Status: **completed**
- Topology: one native session/workspace per arm
- Tasks: 12
- Repetitions included: 1 of 2 configured
- Repetition 2 was intentionally not started.

| Metric | Cuppet | OpenCode |
|---|---:|---:|
| Successful tasks | 11/12 | 11/12 |
| Total model tokens | 12,206 | 13,917 |
| Total uncached input | 10,167 | 10,958 |
| Total cached input | 257,280 | 346,539 |
| Median tool calls/task | 6 | 9.5 |
| Median task duration | 30s | 49s |

## Per-task comparison

| Task | Cuppet tokens | OpenCode tokens | Cuppet duration | OpenCode duration |
|---|---:|---:|---:|---:|
| task-tracker-cross-file | 42,303 | 37,420 | 128s | 105s |
| quiz-game-greenfield | 11,142 | 20,024 | 75s | 117s |
| persistent-build-stage-1 | 11,214 | 13,054 | 66s | 84s |
| persistent-build-stage-2 | 12,966 | 25,015 | 65s | 137s |
| persistent-build-stage-3 | 12,478 | 15,171 | 33s | 69s |
| switch-a-auth | 5,725 | 5,022 | 23s | 29s |
| switch-a-followup | 5,798 | 4,260 | 20s | 19s |
| switch-b-auth | 7,042 | 5,494 | 25s | 25s |
| switch-b-followup | 6,648 | 5,301 | 20s | 19s |
| switch-c | 6,696 | 5,260 | 27s | 29s |
| switch-a-return | 7,856 | 3,874 | 19s | 20s |
| long-tool-use-dashboard | 16,608 | 27,103 | 93s | 180s |

Per-task cache share, marginal uncached input, and early/late summaries are available in the JSON report under `longHorizon`.
