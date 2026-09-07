# Native Cuppet — `actionlint-action-pinning-lint` — Sol/high

This is the completed native Cuppet arm using the classic local runner, with no Docker and no Go toolchain installation.

## Run result

| Metric | Result |
|---|---:|
| Arm status | **success** |
| Model | `openai/gpt-5.6-sol` / `high` |
| Duration | 25m 32.6s |
| Tool calls | 156 |
| Total model tokens | 185,190 |
| Node contract verifier | **27/27 passed** |
| Retries | 0 |

The arm produced a clean committed patch on `feature/action-pinning-rule` at `3724d94`.

## Verification boundary

The local machine did not have Go installed, so the official Go test suite was not run. The replacement Node verifier covered the action-pinning contract, configuration/CLI wiring, scope, documentation, focused tests, and representative ref-behavior cases. It passed all 27 checks.

## Artifacts

- [Machine-readable metrics](metrics.json)
- [Native arm result](raw/result.json)
- [Node verifier result](raw/node-verifier.json)
- [Generated patch](raw/model.patch)
