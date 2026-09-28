# DeepSWE v1.1 — `actionlint-action-pinning-lint`

Status: both executions were incomplete because of infrastructure failures. This is not a valid efficiency ranking.

The experiment used one official DeepSWE task, one attempt per harness, and two model-consuming arms total. Earlier Docker/setup failures occurred before model execution and were excluded from the paid-run count. No automatic retries were made.

## Headline comparison

`Total input` is `uncached input + cached input`. `Normalized model tokens` is `uncached input + output + reasoning`. Percentages are Cuppet minus OpenCode over OpenCode; they are descriptive only because both executions were incomplete and both official rewards are zero.

| Metric | Cuppet | OpenCode | Cuppet difference |
|---|---:|---:|---:|
| Official DeepSWE reward | 0 (`partial 0.725`, incomplete) | 0 (`partial 0.975`, incomplete) | not ranked |
| Total input | 23,880 | 1,970,258 | -98.79% |
| Cached input | 14,336 | 1,875,456 | -99.24% |
| Uncached input | 9,544 | 94,802 | -89.93% |
| Output | 309 | 6,098 | -94.93% |
| Reasoning | 34 | 1,085 | -96.87% |
| Normalized model tokens | 9,887 | 101,985 | -90.31% |
| Observed token volume | 24,189 | 1,976,356 | -98.78% |
| Model rounds | 3 | 36 | -91.67% |
| Tool calls | 6 | 50 | -88.00% |
| Commands | 1 | 15 | -93.33% |
| Model trajectory duration | 50.1 s | 533.6 s | -90.61% |
| Patch files | 0 | 5 | -100.00% |
| Patch bytes | 0 | 11,093 | -100.00% |

## Correctness and failure details

Cuppet execution was incomplete because its native permission infrastructure rejected the first `bash` request needed to continue. The model stopped after inspection and submitted no patch. The official verifier scored the resulting pristine-base state F2P `0/55`, P2P `145/145`, partial `0.725`, reward `0`.

OpenCode produced a five-file patch and reached F2P `54/55`, P2P `141/145`, partial `0.975`, reward `0`. Its native CLI then hung after emitting a final `stop` event; the process was terminated after more than 20 minutes with no new log output. This is an incomplete execution caused by infrastructure failure, not evidence that the OpenCode harness itself is inferior. Its token numbers are preserved but must not be used to claim a harness winner.

The five official failures in the OpenCode patch were:

- commit SHAs and exact semver were incorrectly rejected at less-strict levels;
- expression-only action references were not skipped;
- one mixed-ref case incorrectly rejected a commit SHA.

This is not a valid A–F architecture case: both executions were incomplete for infrastructure reasons. It does not support an architectural efficiency conclusion.

## Experimental identity

- DeepSWE source revision: `0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea`
- Task artifact: `datacurve/actionlint-action-pinning-lint`
- Task artifact digest: `sha256:31f1f6c3b4054e331c40f906409102c23a53f2b9667a3fe779dec4d2704ad4aa`
- Repository: `rhysd/actionlint@0bdc95715fa58f64e3fd6e63b0f89be8733cbbab`
- Prompt SHA-256: `02472c08b7de7ca4d7d709a3b53db835fe8bcc76a887a13c18dc5aba86bd37f9`
- Task definition SHA-256: `a171ddc6849f81f146c05b5fa230341fbc691e26b90edb4d3d80efd274141f66`
- Verifier composite SHA-256: `28dfe0a62d43fbab5838a7fc6dddcd69522e458508d5d37d67251069f0a5b83f`
- Container: `public.ecr.aws/d3j8x8q7/swe-bench-202605:kh79dnvkvq8j9bs22ededmsc79823akj-v1.1@sha256:522a6e93a31656d03cc79474dafc5542bb27109051914d5566d7d29789c2a1a6`
- Resources: 2 CPUs, 8,192 MB RAM, 20,480 MB storage; agent timeout 10,800 s; verifier timeout 1,800 s.
- Controller: Pier 0.3.1.
- Model for both arms: `openai/gpt-5.6-luna`, reasoning `low`.
- OpenCode: stock OpenCode 1.18.4, upstream revision `49c69c5ed3ccf706b61b3febb43c8aaff7f8325e`.
- Cuppet: commit `12e34fc27050889e21215dc3dac95fc2390d9820`, version `0.2.0-alpha.2`, native TST protocol `cuppet.tst.v3`.

## External reference context

The following published values are not part of the primary ranking because they use GPT-5.6 Sol/high rather than Luna/low:

| Published reference | Reward | Rounds | Input | Cached | Output | Reasoning | Normalized fresh/model work |
|---|---:|---:|---:|---:|---:|---:|---:|
| Tura Direct Sol/high run 1 | PASS | 14 | 1,124,432 | 1,009,152 | 17,379 | 4,459 | ~137,118 |
| Tura Direct Sol/high run 2 | PASS | 15 | 1,228,304 | 1,108,224 | 20,004 | 4,745 | ~144,829 |
| Codex Medium | PASS | 47 | 4,676,630 | 4,464,000 | 17,664 | 2,954 | ~233,248 |

## Raw artifacts

- [Full per-round trajectory](context-trajectory.md)
- [Machine-readable metrics and hashes](metrics.json)
- [OpenCode raw JSONL](raw/opencode/opencode.txt)
- [OpenCode ATIF trajectory](raw/opencode/trajectory.json)
- [OpenCode patch](raw/opencode/model.patch)
- [OpenCode official reward](raw/opencode/reward.json)
- [Cuppet native SQLite database](raw/cuppet/opencode.db)
- [Cuppet native OpenCode log](raw/cuppet/opencode.log)
- [Cuppet patch](raw/cuppet/model.patch)
- [Cuppet official verifier output](raw/cuppet/verifier-test-stdout.txt)
