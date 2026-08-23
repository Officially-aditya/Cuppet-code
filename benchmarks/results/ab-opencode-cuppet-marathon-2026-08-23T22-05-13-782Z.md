# Marathon A/B: OpenCode vs Cuppet — 10-stage MiniDB build

- Created: 2026-08-23T22:08:20.073Z
- Model: `opencode/x-preview-f-free`
- One persistent session per arm; stages build cumulatively; every stage verifies the full history (regressions marked !).

| Metric | OpenCode | Cuppet | Cuppet delta |
|---|---:|---:|---:|
| Stages correct | 0/1 | 0/1 | +0 |
| First-attempt correct | 0 | 0 | |
| Repairs needed | 0 | 0 | |
| Regressed stages | 0 | 0 | |
| Total agent time | 177 s | 147 s | 17.1% |
| Uncached input | 24,632 | 19,516 | 20.8% |
| Total model tokens | 31,546 | 23,844 | −24.4% |
| Tool calls | 8 | 9 | −-12.5% |
| Cache share | 67.7% | 83.2% | |
| Compactions | 0 | 0 | |
| Acceptance checks | 0/1 | 0/1 | +0 |

| Stage | OpenCode | Cuppet |
|---|---|---|
| 1. core-store | FAIL · 177s · tok 31,546 · 1 attempt(s) | FAIL · 147s · tok 23,844 · 1 attempt(s) |
| 2. query-api | missing | missing |
| 3. indexes | missing | missing |
| 4. transactions | missing | missing |
| 5. cli-repl | missing | missing |
| 6. aggregation | missing | missing |
| 7. schema-validation | missing | missing |
| 8. durability-reload | missing | missing |
| 9. pluggable-backends | missing | missing |
| 10. atomic-batches | missing | missing |

* = recovered by verification guard. ! = broke at least one earlier stage.
