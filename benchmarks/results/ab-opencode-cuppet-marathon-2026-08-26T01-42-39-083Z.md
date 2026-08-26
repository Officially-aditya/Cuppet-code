# Three-arm marathon benchmark: 10-stage MiniDB build

- Created: 2026-08-26T02:35:42.745Z
- Model: `openai/gpt-5.6-luna` @low
- One persistent session per arm; stages build cumulatively; every stage verifies the full history (regressions marked !).

| Metric | OpenCode | Cuppet | DeepSeek Harness |
|---|---:|---:|---:|
| Stages correct | 2/10 | 2/10 | 8/10 |
| First-attempt correct | 1 | 1 | 6 |
| Repairs needed | 1 | 1 | 2 |
| Regressed stages | 7 | 7 | 0 |
| Total agent time | 1041 s | 740 s | 3136 s |
| Uncached input | 327,509 | 236,923 | 301,163 |
| Total model tokens | 358,186 | 261,554 | 428,665 |
| Tool calls | 117 | 86 | 90 |
| Cache share | 90.1% | 93.1% | 96.5% |
| Compactions | 0 | 0 | 0 |
| Acceptance checks | 46/55 | 46/55 | 53/55 |

| Stage | OpenCode | Cuppet | DeepSeek Harness |
|---|---|---|---|
| 1. core-store | pass · 79s · tok 50,257 · 1 attempt(s) | pass · 49s · tok 18,983 · 1 attempt(s) | pass · 218s · tok 27,763 · 1 attempt(s) |
| 2. query-api | pass* · 69s · tok 21,865 · 2 attempt(s) | pass* · 54s · tok 10,464 · 2 attempt(s) | pass* · 192s · tok 49,214 · 2 attempt(s) |
| 3. indexes | FAIL · 87s · tok 27,376 · 3 attempt(s) | FAIL · 96s · tok 17,912 · 3 attempt(s) | pass* · 701s · tok 139,740 · 3 attempt(s) |
| 4. transactions | FAIL! · 139s · tok 55,342 · 3 attempt(s) | FAIL! · 119s · tok 84,071 · 3 attempt(s) | pass · 251s · tok 41,286 · 1 attempt(s) |
| 5. cli-repl | FAIL! · 115s · tok 23,003 · 3 attempt(s) | FAIL! · 70s · tok 51,974 · 3 attempt(s) | pass · 120s · tok 19,108 · 1 attempt(s) |
| 6. aggregation | FAIL! · 87s · tok 15,269 · 3 attempt(s) | FAIL! · 61s · tok 16,857 · 3 attempt(s) | FAIL · 54s · tok 0 · 1 attempt(s) |
| 7. schema-validation | FAIL! · 62s · tok 17,186 · 3 attempt(s) | FAIL! · 60s · tok 16,188 · 3 attempt(s) | pass · 402s · tok 42,529 · 1 attempt(s) |
| 8. durability-reload | FAIL! · 86s · tok 60,749 · 3 attempt(s) | FAIL! · 80s · tok 9,579 · 3 attempt(s) | pass · 392s · tok 38,476 · 1 attempt(s) |
| 9. pluggable-backends | FAIL! · 162s · tok 70,884 · 3 attempt(s) | FAIL! · 89s · tok 25,354 · 3 attempt(s) | pass · 189s · tok 13,799 · 1 attempt(s) |
| 10. atomic-batches | FAIL! · 153s · tok 16,255 · 3 attempt(s) | FAIL! · 62s · tok 10,172 · 3 attempt(s) | FAIL · 616s · tok 56,750 · 3 attempt(s) |

* = recovered by verification guard. ! = broke at least one earlier stage.
