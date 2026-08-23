# Hard-fixture A/B: OpenCode vs Cuppet

- Created: 2026-08-23T17:46:45.969Z
- Model: `opencode/x-preview-f-free`
- Fixture: 22 files, hash 435a99496a59…
- Both arms: persistent sessions, concurrent per task, verification guard enabled.

| Metric | OpenCode | Cuppet | Cuppet delta |
|---|---:|---:|---:|
| Correct tasks | 3/5 | 5/5 | +2 |
| First-attempt correct | 3 | 3 |  |
| Repairs needed | 0 | 2 |  |
| Total agent time | 1261 s | 1001 s | −20.6% |
| Median task time | 184 s | 151 s | −17.9% |
| Uncached input | 84,454 | 76,918 | −8.9% |
| Total model tokens | 124,519 | 100,756 | −19.1% |
| Tool calls | 108 | 80 | −25.9% |
| Cache share | 97.7% | 97.1% | -0.7 pp |
| Acceptance checks | 31/33 | 33/33 | +2 |

| Task | OpenCode | Cuppet |
|---|---|---|
| Rename internal total without changing the wire format | pass (7/7) · 115s · in 33,011 / tok 36,222 | pass (7/7) · 151s · in 35,117 / tok 37,020 |
| Thread discount codes through the entire stack | FAIL (7/8) · 524s · in 24,897 / tok 42,177 | pass* (8/8) · 232s · in 13,409 / tok 20,127 |
| Fix double-billing on rapid subscription renewals | pass (5/5) · 184s · in 7,979 / tok 13,925 | pass (5/5) · 86s · in 4,612 / tok 7,415 |
| Consolidate duplicated rounding into one util | pass (7/7) · 127s · in 5,452 / tok 9,100 | pass (7/7) · 135s · in 5,381 / tok 7,519 |
| Guarantee audit-first ordering and resilient notifications | FAIL (5/6) · 312s · in 13,115 / tok 23,095 | pass* (6/6) · 398s · in 18,399 / tok 28,675 |

* = recovered by the verification guard. Time/tokens aggregate across all attempts of a task.
