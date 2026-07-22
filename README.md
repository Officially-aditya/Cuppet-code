# Cuppet public alpha

Cuppet is an Ink terminal coding-agent supervisor backed by a pinned OpenCode
server and a native Rust tiered-memory/code-graph daemon.

The alpha pins OpenCode and `@opencode-ai/sdk` to the stable **v1.18.4** release
at revision `49c69c5ed3ccf706b61b3febb43c8aaff7f8325e`. Provider credentials, tools,
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

For a source checkout with a locally packaged runtime, run
`npm run install:global`. The installer packs the runtime and CLI before
installing them, so the global commands never symlink back into the checkout
(which macOS may block when the repository is under `Downloads`). Typing
`cupet` then launches Cuppet from any directory; `cuppet` remains available as
the canonical command. The standard `cc` C compiler is never shadowed.

On first launch, Cuppet asks for a platform before showing models. Choose
Anthropic, OpenAI, Google (Gemini API), Vertex AI (Google Cloud ADC), or
OpenCode; if needed, the matching OpenCode authentication flow appears before
the live model picker. Vertex detects either `GOOGLE_APPLICATION_CREDENTIALS`
or standard gcloud application-default credentials. When neither is present,
run `gcloud auth application-default login`, set `GOOGLE_CLOUD_PROJECT` (or
`GOOGLE_VERTEX_PROJECT`), and restart Cuppet. Cuppet passes
`GOOGLE_VERTEX_LOCATION=global` by default; `GOOGLE_VERTEX_LOCATION` or
`GOOGLE_CLOUD_LOCATION` can override it. Provider connections coexist: `/platform` filters the model picker;
it does not disconnect other providers. The platform and model choices contain
no credentials and are remembered. Run `/platform` to repeat this selection
later.

## Architecture

```text
Ink UI + Cuppet supervisor
  ├─ OpenCode 1.18.4 + SDK catalog/auth/session APIs + SSE
  │  └─ sessions, tools, permissions, models, diffs, auth, undo
  └─ tst-daemon (framed JSON-RPC 2.0 over a private Unix socket)
     └─ session STM, verified project/global LTM, Tree-sitter graph, WAL
```

Project stores live at `~/.cuppet/v2/projects/<sha256(realpath)>`. Runtime
sockets use a mode-0700 launch directory and mode-0600 socket. OpenCode is
given isolated XDG config/data/cache/state directories below
`~/.cuppet/v2/opencode`; Cuppet never parses its credential records.

Cuppet uses OpenCode's v2 APIs for the live catalog and agent registration and
the same bundled server's stable session/provider API for turns. This preserves
the mature Google Vertex, Azure, Gemini, Anthropic, and OpenAI adapters while
OpenCode's v2 runner supports a smaller adapter set. No provider SDK or
credential store is implemented in Cuppet.

## Alpha limits

Windows, musl, remote daemons, cloud memory sync, vector databases, and
multi-user operation are not supported. One Cuppet process may own writable
memory for a project; it can manage multiple OpenCode sessions. Offline means
no runtime binary download, not offline provider inference.

## License

Apache-2.0. Bundled third-party notices are in `THIRD_PARTY_NOTICES.md`.
