# Hard-fixture A/B: OpenCode vs Cuppet

- Created: 2026-08-23T16:22:36.555Z
- Model: `opencode/deepseek-v4-flash-free`
- Fixture: 22 files, hash 435a99496a59…
- Both arms: persistent sessions, concurrent per task, verification guard enabled.

| Metric | OpenCode | Cuppet | Cuppet delta |
|---|---:|---:|---:|
| Correct tasks | 0/5 | 0/5 | +0 |
| First-attempt correct | 0 | 0 |  |
| Repairs needed | 0 | 0 |  |
| Total agent time | 23 s | 23 s | +0.0% (slower) |
| Median task time | 5 s | 5 s | −0.0% |
| Uncached input | 0 | 0 | −0.0% |
| Total model tokens | 0 | 0 | −0.0% |
| Tool calls | 0 | 0 | −0.0% |
| Cache share | 0.0% | 0.0% | 0.0 pp |
| Acceptance checks | 18/33 | 18/33 | +0 |

| Task | OpenCode | Cuppet |
|---|---|---|
| Rename internal total without changing the wire format | FAIL (4/7) · 5s · in 0 / tok 0 | FAIL (4/7) · 5s · in 0 / tok 0 |
| Thread discount codes through the entire stack | FAIL (4/8) · 5s · in 0 / tok 0 | FAIL (4/8) · 5s · in 0 / tok 0 |
| Fix double-billing on rapid subscription renewals | FAIL (4/5) · 4s · in 0 / tok 0 | FAIL (4/5) · 4s · in 0 / tok 0 |
| Consolidate duplicated rounding into one util | FAIL (3/7) · 5s · in 0 / tok 0 | FAIL (3/7) · 5s · in 0 / tok 0 |
| Guarantee audit-first ordering and resilient notifications | FAIL (3/6) · 5s · in 0 / tok 0 | FAIL (3/6) · 5s · in 0 / tok 0 |

* = recovered by the verification guard. Time/tokens aggregate across all attempts of a task.
