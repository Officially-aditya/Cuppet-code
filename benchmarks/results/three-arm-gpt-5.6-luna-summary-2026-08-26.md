# Three-arm benchmark summary — GPT-5.6 Luna

Run date: 2026-08-26  
Arms: official OpenCode, Cuppet, and DeepSeek Harness  
Model request: `gpt-5.6-luna`, variant `low`

## Executive picture

| Decision axis | Winner in this matrix | Evidence |
|---|---|---|
| Uncached-input reduction | Cuppet | 37.6% lower than OpenCode on hard tasks; 76.3% lower on the 10-project suite; 27.7% lower on the marathon |
| Total model-token reduction | Cuppet | 36.3%, 70.8%, and 27.0% lower than OpenCode across the three suites |
| Short-suite correctness | Tie | Hard: all arms 4/5; 10-project suite: all arms 10/10 |
| Stateful marathon correctness | Harness in this run, but confounded | Harness reached 8/10 stages and 53/55 checks; OpenCode and Cuppet reached 2/10 and 46/55 after sharing the same concrete `indexes` defect |
| Wall-clock speed | Mixed, with Harness slowest | Cuppet was 7.5% slower on hard tasks and 25.2% slower on the 10-project suite, but 28.9% faster on the marathon; Harness was roughly 2.9–3.0x slower than OpenCode in every suite |

## Fresh three-arm results

`Time` is cumulative agent duration. `Uncached input` excludes cache-read tokens. `Model tokens` is the reported non-cache model total (`input + output + reasoning`), not total tokens including cache reads.

| Suite | Arm | Outcome | Checks | Time | Uncached input | Model tokens | Tool calls | First attempt / repaired |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Hard, 5 tasks | OpenCode | 4/5 | 32/33 | 362.0s | 147,831 | 159,969 | 98 | 3 / 1 |
| Hard, 5 tasks | Cuppet | 4/5 | 32/33 | 389.1s | 92,313 | 101,924 | 72 | 3 / 1 |
| Hard, 5 tasks | DeepSeek Harness | 4/5 | 32/33 | 1,078.6s | 149,234 | 196,578 | 148 | 3 / 1 |
| Sequential web projects, 10 tasks | OpenCode | 10/10 | 163/163 | 1,464.5s | 628,051 | 687,688 | 122 | 10 / 0 |
| Sequential web projects, 10 tasks | Cuppet | 10/10 | 163/163 | 1,833.2s | 149,018 | 200,771 | 128 | 10 / 0 |
| Sequential web projects, 10 tasks | DeepSeek Harness | 10/10 | 163/163 | 4,252.2s | 594,674 | 780,625 | 113 | 9 / 1 |
| Stateful marathon, 10 stages | OpenCode | 2/10 | 46/55 | 1,040.5s | 327,509 | 358,186 | 117 | 1 / 1 |
| Stateful marathon, 10 stages | Cuppet | 2/10 | 46/55 | 739.7s | 236,923 | 261,554 | 86 | 1 / 1 |
| Stateful marathon, 10 stages | DeepSeek Harness | 8/10 | 53/55 | 3,136.2s | 301,163 | 428,665 | 90 | 6 / 2 |

## Pairwise deltas

Positive reductions mean the candidate used less of the metric. Negative time means the candidate was slower.

| Suite | Cuppet vs OpenCode | DeepSeek Harness vs OpenCode | Cuppet vs DeepSeek Harness |
|---|---|---|---|
| Hard | 7.5% slower; 37.6% less uncached input; 36.3% fewer model tokens; correctness tied | 198.0% slower; 0.9% more uncached input; 22.9% more model tokens; correctness tied | 63.9% faster; 38.1% less uncached input; 48.2% fewer model tokens |
| 10 sequential projects | 25.2% slower; 76.3% less uncached input; 70.8% fewer model tokens; correctness tied | 190.4% slower; 5.3% less uncached input; 13.5% more model tokens; correctness tied | 56.9% faster; 74.9% less uncached input; 74.3% fewer model tokens |
| Stateful marathon | 28.9% faster; 27.7% less uncached input; 27.0% fewer model tokens; checks tied | 201.4% slower; 8.0% less uncached input; 19.7% more model tokens; +6 successful stages and +7 checks | 76.4% faster; 21.3% less uncached input; 39.0% fewer model tokens; −6 successful stages and −7 checks |

## Marathon stage matrix

The marathon is stateful: an early failed implementation can cause later regression checks to fail. OpenCode and Cuppet both failed the `indexes` stage, and their seven later regression stages remained red. Harness repaired `indexes`, kept all regression checks green through `pluggable-backends`, and only failed the final `atomic-batches` behavior check. Its `aggregation` stage also ended after a disconnected WebSocket without a model attempt.

| Stage | OpenCode | Cuppet | DeepSeek Harness |
|---|:---:|:---:|:---:|
| core-store | PASS | PASS | PASS |
| query-api | PASS | PASS | PASS |
| indexes | FAIL | FAIL | PASS after repair |
| transactions | FAIL — regression | FAIL — regression | PASS |
| cli-repl | FAIL — regression | FAIL — regression | PASS |
| aggregation | FAIL — regression | FAIL — regression | FAIL — disconnected session |
| schema-validation | FAIL — regression | FAIL — regression | PASS |
| durability-reload | FAIL — regression | FAIL — regression | PASS |
| pluggable-backends | FAIL — regression | FAIL — regression | PASS |
| atomic-batches | FAIL — regression | FAIL — regression | FAIL — behavior |

## Aborted rerun diagnosis

The requested repeat was stopped after stage 7 once it reproduced the same `indexes` signature. The verifier intentionally keeps the unique `email` index active and then inserts two documents containing only `{ tag: 'x' }`; missing indexed fields are expected to be ignored. The OpenCode and Cuppet implementations generated in this run serialize the missing `email` value as one shared index key, so the second tag-only insert raises `Duplicate value for unique index: email`. Harness skips absent indexed values and passes the same check.

This explains the apparent 2/10 result: the marathon’s regression guard correctly propagates the broken `indexes` state into later stages, but those seven red rows are cascade failures rather than seven independent task failures. The marathon correctness comparison should remain provisional until OpenCode and Cuppet are rerun with this contract satisfied.

## Context-only combined totals

These totals are descriptive, not a single normalized score: the suites have different task shapes and the marathon contains cascading state.

| Arm | Successful units | Checks | Total time | Uncached input | Model tokens |
|---|---:|---:|---:|---:|---:|
| OpenCode | 16/25 | 241/251 | 47.8 min | 1,103,391 | 1,205,843 |
| Cuppet | 16/25 | 241/251 | 49.4 min | 478,254 | 564,249 |
| DeepSeek Harness | 22/25 | 248/251 | 141.1 min | 1,045,071 | 1,405,868 |

## What this supports

1. Cuppet is the clear token-efficiency winner in this GPT-5.6 Luna matrix. Its strongest result is the 10-project suite: 76.3% less uncached input and 70.8% fewer reported model tokens than OpenCode, at a 25.2% wall-clock penalty.
2. Harness is not the efficiency winner here. It is dramatically slower and uses more reported model tokens than OpenCode, although it uses slightly less uncached input and makes fewer tool calls in the 10-project suite.
3. Harness did show a meaningful correctness advantage in this stateful run, but the advantage is confounded by the concrete missing-field/unique-index defect reproduced in both OpenCode and Cuppet. It should not be generalized to Harness without a corrected rerun.
4. The result is runtime/provider-path specific, not a pure model-quality comparison. All arms requested the same model identifier, but Harness used the persistent `openai-codex` route while OpenCode and Cuppet used their native runtime paths. A provider-neutral DeepSeek V4 Flash comparison still requires running the same matrix with all three arms pointed at the same OpenRouter endpoint.
5. No cost ranking is included: the benchmark reports did not return usable dollar costs. Harness also lacks event-level step samples in these runs, so its adjusted cache-share field is not comparable; the raw token counters above are used instead.

## Raw reports

- [Hard suite JSON](ab-opencode-cuppet-hard-2026-08-26T00-11-41-331Z.json) · [summary](ab-opencode-cuppet-hard-2026-08-26T00-11-41-331Z.md)
- [10-project suite JSON](ab-opencode-cuppet-10-tasks-2026-08-26T00-30-46-581Z.json) · [summary](ab-opencode-cuppet-10-tasks-2026-08-26T00-30-46-581Z.md)
- [Marathon JSON](ab-opencode-cuppet-marathon-2026-08-26T01-42-39-083Z.json) · [summary](ab-opencode-cuppet-marathon-2026-08-26T01-42-39-083Z.md)
