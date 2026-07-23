# A/B pilot — 2026-07-22

- Model: `google-vertex/gemini-flash-latest`
- Kernel: bundled official OpenCode 1.18.4
- Design: five paired fresh-session read-only code-navigation tasks
- Raw data: `ab-2026-07-22T17-39-35.297Z.json`

| Metric | Plain OpenCode | Cuppet | Difference |
|---|---:|---:|---:|
| Successful tasks | 4/5 | 5/5 | +20 percentage points |
| Median uncached input per successful task | 13,293.5 | 8,019 | 39.7% lower |
| Median latency per successful task | 31,732 ms | 15,661 ms | 16,071 ms faster |
| Median cost per successful task | $0.047906 | $0.026478 | $0.021428 lower |
| Total cost, including failures | $0.251780 | $0.150976 | $0.100804 lower |
| Median injected context | 0 | 1,220 tokens | +1,220 tokens |

The result is directionally positive, but the sample is small and task scope is
narrow. It does not yet satisfy the release requirement for a representative
multi-turn coding evaluation.
