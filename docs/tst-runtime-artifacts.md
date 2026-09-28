# Standalone TST runtime artifacts

Cuppet desktop consumes the native TST daemon without the OpenCode derivative or OpenCode plugins. The daemon remains built from the same `tst-core` / `tst-daemon` sources and speaks the existing `cuppet.tst.v3` authenticated framed JSON-RPC protocol.

## Build contract

`scripts/package-tst-runtime.mjs` accepts a native `tst-daemon`, executes `tst-daemon --protocol`, and refuses to package anything other than `cuppet.tst.v3`. It then emits a minimal runtime directory containing:

- `bin/tst-daemon`;
- `tst-runtime.json` with platform, architecture, libc, source revision, protocol and SHA-256 identity;
- `LICENSE`, `NOTICE`, and `THIRD_PARTY_NOTICES.md`.

No OpenCode binary, OpenCode patch, provider code, plugin, transcript, model, or credential is copied into this payload.

The supported release matrix matches the native Cuppet runtime matrix:

- `darwin-arm64`;
- `darwin-x64`;
- `linux-arm64-gnu`;
- `linux-x64-gnu`.

Windows is not advertised as a managed native TST platform until Cuppet ships and tests a Windows daemon artifact.

## Release contract

The normal platform release build signs the macOS `tst-daemon` before the standalone payload is copied from that signed artifact. Every platform job creates a sibling `tst-runtime-*` directory. The release verifier requires one standalone TST payload for every normal platform runtime and rechecks its SHA-256 identity. On a host that can execute the payload it can also re-run the protocol identity check.

`create-release-assets.mjs` publishes these immutable GitHub release assets alongside the existing Cuppet runtime archives:

- `cuppet-tst-darwin-arm64.tar.gz`;
- `cuppet-tst-darwin-x64.tar.gz`;
- `cuppet-tst-linux-arm64-gnu.tar.gz`;
- `cuppet-tst-linux-x64-gnu.tar.gz`.

They are covered by the release `SHA256SUMS` file.

## Desktop ownership

The standalone artifact exists so Cuppet desktop can own TST lifecycle directly: it can package only `tst-daemon`, create project/global stores, launch a private authenticated daemon per active project, and shut it down without installing or invoking the OpenCode-derived Cuppet CLI runtime.
