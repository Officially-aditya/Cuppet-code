# Marathon A/B: OpenCode vs Cuppet — 10-stage MiniDB build

- Created: 2026-08-23T21:02:18.703Z
- Model: `opencode/x-preview-f-free`
- One persistent session per arm; stages build cumulatively; every stage verifies the full history (regressions marked !).

| Metric | OpenCode | Cuppet | Cuppet delta |
|---|---:|---:|---:|
| Stages correct | 9/10 | 9/10 | +0 |
| First-attempt correct | 6 | 8 | |
| Repairs needed | 3 | 1 | |
| Regressed stages | 0 | 0 | |
| Total agent time | 5166 s | 7614 s | -47.4% |
| Uncached input | 315,805 | 172,458 | 45.4% |
| Total model tokens | 453,015 | 298,655 | −34.1% |
| Tool calls | 113 | 150 | −-32.7% |
| Cache share | 96.9% | 98.9% | |
| Compactions | 0 | 0 | |
| Acceptance checks | 54/55 | 54/55 | +0 |

| Stage | OpenCode | Cuppet |
|---|---|---|
| 1. core-store | pass* · 543s · tok 71,770 · 3 attempt(s) | FAIL · 599s · tok 48,228 · 3 attempt(s) |
| 2. query-api | pass* · 437s · tok 35,738 · 2 attempt(s) | pass* · 1117s · tok 59,421 · 3 attempt(s) |
| 3. indexes | pass · 190s · tok 16,134 · 1 attempt(s) | pass · 365s · tok 15,122 · 1 attempt(s) |
| 4. transactions | pass* · 382s · tok 32,237 · 2 attempt(s) | pass · 925s · tok 38,854 · 1 attempt(s) |
| 5. cli-repl | pass · 354s · tok 18,626 · 1 attempt(s) | pass · 377s · tok 16,826 · 1 attempt(s) |
| 6. aggregation | pass · 748s · tok 29,798 · 1 attempt(s) | pass · 512s · tok 22,285 · 1 attempt(s) |
| 7. schema-validation | pass · 691s · tok 18,704 · 1 attempt(s) | pass · 555s · tok 16,912 · 1 attempt(s) |
| 8. durability-reload | pass · 482s · tok 17,436 · 1 attempt(s) | pass · 805s · tok 25,842 · 1 attempt(s) |
| 9. pluggable-backends | pass · 420s · tok 14,401 · 1 attempt(s) | pass · 990s · tok 20,650 · 1 attempt(s) |
| 10. atomic-batches | FAIL · 921s · tok 198,171 · 3 attempt(s) | pass · 1369s · tok 34,515 · 1 attempt(s) |

* = recovered by verification guard. ! = broke at least one earlier stage.
