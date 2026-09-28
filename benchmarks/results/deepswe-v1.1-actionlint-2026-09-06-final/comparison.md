# DeepSWE v1.1 corrected run — `actionlint-action-pinning-lint`

Both arms completed deterministically in the official environment. There were no agent exceptions, proxy failures, permission aborts, or post-stop hangs. Both received the same task, model, reasoning level, resource limits, network policy, and verifier.

## Headline comparison

`Total input` is `uncached input + cached input`. `Normalized model tokens` is `uncached input + output + reasoning`. Percentages are Cuppet minus OpenCode over OpenCode.

| Metric | Cuppet | OpenCode | Cuppet difference |
|---|---:|---:|---:|
| Official DeepSWE reward | 0 (`partial 0.980`) | 0 (`partial 0.990`) | not a pass |
| Total input | 823,534 | 1,626,585 | -49.37% |
| Cached input | 761,344 | 1,533,952 | -50.37% |
| Uncached input | 62,190 | 92,633 | -32.86% |
| Output | 4,918 | 4,924 | -0.12% |
| Reasoning | 802 | 1,237 | -35.17% |
| Normalized model tokens | 67,910 | 98,794 | -31.26% |
| Observed token volume | 828,452 | 1,631,509 | -49.22% |
| Model rounds | 22 | 31 | -29.03% |
| Tool calls | 42 | 43 | -2.33% |
| Commands | 7 | 12 | -41.67% |
| Model trajectory duration | 437.6 s | 521.9 s | -16.14% |
| Patch files | 4 | 5 | -20.00% |
| Patch bytes | 9,874 | 12,018 | -17.84% |

## Correctness

Both executions reached the verifier normally, but both received the official binary reward `0`:

- Cuppet: F2P `54/55`, P2P `142/145`, partial `0.980`.
- OpenCode: F2P `54/55`, P2P `144/145`, partial `0.990`.

OpenCode missed `TestActionPinningSemverPassesCommitSHA` and `TestActionPinningSemverMixedRefs`. Cuppet missed those plus the two major-minor acceptance tests for commit SHA and exact semver.

This is Case F: both arms fail the official binary verifier. The token reduction is descriptive, but correctness takes precedence; no architecture winner should be claimed from this single failed task.

## Determinism corrections

- Stock OpenCode used native provider timeouts: full request `1,800,000 ms`, header `120,000 ms`, chunk `300,000 ms`.
- The wrapper terminated OpenCode normally after a native `step_finish` with `reason=stop`, preventing the prior post-stop hang.
- Cuppet used a benchmark-only headless permission gate that auto-approved workspace edits and bash inside the isolated official container, preventing permission prompts from aborting the task.
- Native Cuppet TST ran against the internal `/app` workspace; the persisted graph and event WAL are included in the raw artifacts.

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
- Model: `openai/gpt-5.6-luna`, reasoning `low`, both arms.
- OpenCode: stock OpenCode 1.18.4, upstream revision `49c69c5ed3ccf706b61b3febb43c8aaff7f8325e`.
- Cuppet: commit `64fa9a0bbaf2924ce53b30df745f82be07a2767c`, version `0.2.0-alpha.2`, native TST protocol `cuppet.tst.v3`.

## External reference context

These published references are separate because they use GPT-5.6 Sol/high rather than Luna/low:

| Published reference | Reward | Rounds | Input | Cached | Output | Reasoning | Normalized fresh/model work |
|---|---:|---:|---:|---:|---:|---:|---:|
| Tura Direct Sol/high run 1 | PASS | 14 | 1,124,432 | 1,009,152 | 17,379 | 4,459 | ~137,118 |
| Tura Direct Sol/high run 2 | PASS | 15 | 1,228,304 | 1,108,224 | 20,004 | 4,745 | ~144,829 |
| Codex Medium | PASS | 47 | 4,676,630 | 4,464,000 | 17,664 | 2,954 | ~233,248 |

## Raw artifacts

- [Machine-readable metrics and hashes](metrics.json)
- [Full per-round context trajectory](context-trajectory.md)
- [OpenCode raw JSONL](raw/opencode/opencode.txt)
- [OpenCode ATIF trajectory](raw/opencode/trajectory.json)
- [OpenCode patch](raw/opencode/model.patch)
- [OpenCode verifier output](raw/opencode/ctrf.json)
- [Cuppet native SQLite database](raw/cuppet/opencode.db)
- [Cuppet native OpenCode log](raw/cuppet/opencode.log)
- [Cuppet patch](raw/cuppet/model.patch)
- [Cuppet verifier output](raw/cuppet/ctrf.json)
- [Benchmark harness corrections](raw/harness/deepswe_agents.py)
