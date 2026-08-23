# Hard-fixture A/B: OpenCode vs Cuppet

- Created: 2026-08-23T16:17:46.086Z
- Model: `opencode/x-preview-f-free`
- Fixture: 22 files, hash 435a99496a59…
- Both arms: persistent sessions, concurrent per task, verification guard enabled.

| Metric | OpenCode | Cuppet | Cuppet delta |
|---|---:|---:|---:|
| Correct tasks | 0/5 | 0/5 | +0 |
| First-attempt correct | 0 | 0 |  |
| Repairs needed | 0 | 0 |  |
| Total agent time | 46 s | 104 s | +128.8% (slower) |
| Median task time | 9 s | 20 s | +129.1% (slower) |
| Uncached input | 0 | 0 | −0.0% |
| Total model tokens | 0 | 0 | −0.0% |
| Tool calls | 0 | 0 | −0.0% |
| Cache share | 0.0% | 0.0% | 0.0 pp |
| Acceptance checks | 18/33 | 18/33 | +0 |

| Task | OpenCode | Cuppet |
|---|---|---|
| Rename internal total without changing the wire format | FAIL (4/7) · 12s · in 0 / tok 0 | FAIL (4/7) · 23s · in 0 / tok 0 |
| Thread discount codes through the entire stack | FAIL (4/8) · 7s · in 0 / tok 0 | FAIL (4/8) · 20s · in 0 / tok 0 |
| Fix double-billing on rapid subscription renewals | FAIL (4/5) · 8s · in 0 / tok 0 | FAIL (4/5) · 19s · in 0 / tok 0 |
| Consolidate duplicated rounding into one util | FAIL (3/7) · 10s · in 0 / tok 0 | FAIL (3/7) · 20s · in 0 / tok 0 |
| Guarantee audit-first ordering and resilient notifications | FAIL (3/6) · 9s · in 0 / tok 0 | FAIL (3/6) · 23s · in 0 / tok 0 |

* = recovered by the verification guard. Time/tokens aggregate across all attempts of a task.
