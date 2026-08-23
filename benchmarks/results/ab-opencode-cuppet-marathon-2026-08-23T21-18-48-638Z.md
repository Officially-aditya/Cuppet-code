# Marathon A/B: OpenCode vs Cuppet — 10-stage MiniDB build

- Created: 2026-08-23T21:51:15.299Z
- Model: `opencode/x-preview-f-free`
- One persistent session per arm; stages build cumulatively; every stage verifies the full history (regressions marked !).

| Metric | OpenCode | Cuppet | Cuppet delta |
|---|---:|---:|---:|
| Stages correct | 1/2 | 0/2 | -1 |
| First-attempt correct | 0 | 0 | |
| Repairs needed | 1 | 0 | |
| Regressed stages | 0 | 1 | |
| Total agent time | 1704 s | 1469 s | 13.8% |
| Uncached input | 108,155 | 113,977 | -5.4% |
| Total model tokens | 157,344 | 153,560 | −2.4% |
| Tool calls | 60 | 28 | −53.3% |
| Cache share | 96.8% | 88.9% | |
| Compactions | 0 | 0 | |
| Acceptance checks | 2/3 | 1/3 | -1 |

| Stage | OpenCode | Cuppet |
|---|---|---|
| 1. core-store | FAIL · 366s · tok 46,965 · 3 attempt(s) | FAIL · 602s · tok 106,197 · 3 attempt(s) |
| 2. query-api | pass* · 1338s · tok 110,379 · 3 attempt(s) | FAIL! · 867s · tok 47,363 · 3 attempt(s) |
| 3. indexes | missing | missing |
| 4. transactions | missing | missing |
| 5. cli-repl | missing | missing |
| 6. aggregation | missing | missing |
| 7. schema-validation | missing | missing |
| 8. durability-reload | missing | missing |
| 9. pluggable-backends | missing | missing |
| 10. atomic-batches | missing | missing |

* = recovered by verification guard. ! = broke at least one earlier stage.
