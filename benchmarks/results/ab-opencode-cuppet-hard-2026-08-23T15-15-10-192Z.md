# Hard-fixture A/B: OpenCode vs Cuppet

- Created: 2026-08-23T16:04:59.254Z
- Model: `opencode/x-preview-f-free`
- Fixture: 22 files, hash 435a99496a59…
- Both arms: persistent sessions, concurrent per task, verification guard enabled.

| Metric | OpenCode | Cuppet | Cuppet delta |
|---|---:|---:|---:|
| Correct tasks | 0/5 | 0/5 | +0 |
| First-attempt correct | 0 | 0 |  |
| Repairs needed | 0 | 0 |  |
| Total agent time | 2621 s | 2002 s | 23.6% |
| Median task time | 410 s | 329 s | 19.8% |
| Uncached input | 76,742 | 80,648 | −-5.1% |
| Total model tokens | 123,949 | 114,268 | −7.8% |
| Tool calls | 113 | 107 | −5.3% |
| Cache share | 98.4% | 98.3% | -0.0 pp |
| Acceptance checks | 15/33 | 15/33 | +0 |

| Task | OpenCode | Cuppet |
|---|---|---|
| Rename internal total without changing the wire format | FAIL (3/7) · 317s · in 23,500 / tok 30,654 | FAIL (3/7) · 534s · in 24,772 / tok 28,821 |
| Thread discount codes through the entire stack | FAIL (3/8) · 552s · in 23,202 / tok 40,504 | FAIL (3/8) · 679s · in 26,374 / tok 41,344 |
| Fix double-billing on rapid subscription renewals | FAIL (3/5) · 312s · in 11,889 / tok 20,740 | FAIL (3/5) · 329s · in 12,329 / tok 19,276 |
| Consolidate duplicated rounding into one util | FAIL (3/7) · 410s · in 12,568 / tok 22,635 | FAIL (3/7) · 296s · in 9,175 / tok 13,609 |
| Guarantee audit-first ordering and resilient notifications | FAIL (3/6) · 1030s · in 5,583 / tok 9,416 | FAIL (3/6) · 165s · in 7,998 / tok 11,218 |

* = recovered by the verification guard. Time/tokens aggregate across all attempts of a task.
