# Cuppet public alpha

Cuppet is an Ink terminal coding-agent supervisor backed by a pinned OpenCode
server and a native Rust tiered-memory/code-graph daemon.

The alpha pins OpenCode and `@opencode-ai/sdk` to **1.18.4** at revision
`0317531906d3f3bb01cf33c16319870cfde9170c`. Provider credentials, tools,
sessions, model routing, diffs, permissions, compaction, and undo stay inside
OpenCode. Cuppet stores only non-secret UI/model selections and verified
memory records.

## Requirements

- Node.js 22 or newer
- Rust 1.82 or newer for source builds
- macOS 13+ or Ubuntu 22.04+ on arm64/x64
- The pinned OpenCode binary (a release package includes it; source builds can
  set `CUPPET_OPENCODE_BIN`)

## Develop

```sh
npm ci
npm run build
npm test
CUPPET_OPENCODE_BIN=/path/to/opencode npm run dev
```

The Rust daemon is discovered at `target/debug/tst-daemon` during development.
Run `cuppet --doctor` for checksum, protocol, storage, provider, and graph
diagnostics. Cuppet starts in visible OpenCode-only degraded mode if TST is not
available, but it stops the agent loop when OpenCode itself cannot start.

## Architecture

```text
Ink UI + Cuppet supervisor
  ├─ OpenCode 1.18.4 + SDK v2/SSE
  │  └─ sessions, tools, permissions, models, diffs, auth, undo
  └─ tst-daemon (framed JSON-RPC 2.0 over a private Unix socket)
     └─ session STM, verified project/global LTM, Tree-sitter graph, WAL
```

Project stores live at `~/.cuppet/v2/projects/<sha256(realpath)>`. Runtime
sockets use a mode-0700 launch directory and mode-0600 socket. OpenCode is
given isolated XDG config/data/cache directories below
`~/.cuppet/v2/opencode`; Cuppet never parses its credential records.

## Alpha limits

Windows, musl, remote daemons, cloud memory sync, vector databases, and
multi-user operation are not supported. One Cuppet process may own writable
memory for a project; it can manage multiple OpenCode sessions. Offline means
no runtime binary download, not offline provider inference.

## License

Apache-2.0. Bundled third-party notices are in `THIRD_PARTY_NOTICES.md`.
