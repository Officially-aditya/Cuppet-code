# Hard-fixture benchmark: OpenCode vs Cuppet vs DeepSeek Harness

- Created: 2026-08-26T00:29:53.199Z
- Model: `openai/gpt-5.6-luna` @low
- Fixture: 22 files, hash 435a99496a59…
- All arms: persistent sessions, concurrent per task, verification guard enabled.

| Metric | OpenCode | Cuppet | DeepSeek Harness |
|---|---:|---:|---:|
| Correct tasks | 4/5 | 4/5 | 4/5 |
| First-attempt correct | 3 | 3 | 3 |
| Repairs needed | 1 | 1 | 1 |
| Total agent time | 362 s | 389 s | 1079 s |
| Median task time | 75 s | 74 s | 125 s |
| Uncached input | 147,831 | 92,313 | 149,234 |
| Total model tokens | 159,969 | 101,924 | 196,578 |
| Tool calls | 98 | 72 | 148 |
| Cache share | 90.6% | 91.0% | 96.3% |
| Acceptance checks | 32/33 | 32/33 | 32/33 |

| Task | OpenCode | Cuppet | DeepSeek Harness |
|---|---|---|---|
| Rename internal total without changing the wire format | pass (7/7) · 75s · in 28,779 / tok 31,082 | pass (7/7) · 86s · in 23,487 / tok 25,059 | pass (7/7) · 125s · in 14,069 / tok 18,333 |
| Thread discount codes through the entire stack | pass* (8/8) · 107s · in 17,638 / tok 21,786 | pass* (8/8) · 158s · in 16,001 / tok 19,276 | pass* (8/8) · 603s · in 82,429 / tok 110,881 |
| Fix double-billing on rapid subscription renewals | pass (5/5) · 51s · in 37,233 / tok 39,048 | pass (5/5) · 34s · in 32,522 / tok 33,738 | pass (5/5) · 83s · in 11,086 / tok 14,979 |
| Consolidate duplicated rounding into one util | pass (7/7) · 42s · in 7,447 / tok 8,789 | pass (7/7) · 36s · in 7,563 / tok 8,580 | pass (7/7) · 68s · in 14,709 / tok 16,780 |
| Guarantee audit-first ordering and resilient notifications | FAIL (5/6) · 87s · in 56,734 / tok 59,264 | FAIL (5/6) · 74s · in 12,740 / tok 15,271 | FAIL (5/6) · 200s · in 26,941 / tok 35,605 |

* = recovered by the verification guard. Time/tokens aggregate across all attempts of a task. Pairwise reductions remain in the JSON report under summary.comparisons.
