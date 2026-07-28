# Cuppet derivative architecture

Cuppet launches one private OpenCode server per terminal invocation. The
OpenCode binary is built from the pinned revision in a detached worktree,
after applying the numbered files in `patches/opencode/`. A sidecar marker and
runtime manifest bind the binary to the upstream revision and patch-set digest;
stock OpenCode binaries are rejected.

The wrapper starts TST and the OpenCode server, then attaches the derived
native TUI. The TUI owns provider connection, model/session selection, plan
mode, compaction, undo, permissions, questions, and terminal rendering. The
wrapper observes OpenCode events through the SDK and adopts sessions created or
switched by the TUI. Evidence is keyed by session ID so diffs, recent symbols,
tools, usage, and background observations cannot cross session boundaries.

The server plugin exposes memory and graph tools and performs observation hooks.
The TUI plugin registers Cuppet command-palette entries. Both use the
launch-scoped, authenticated Unix socket; it is never bound to a network
interface. Context retrieval is delivered as a synthetic prompt part while the
ordinary persisted user message remains unchanged.

The pinned derivative passes request-scoped session, agent, model, phase, and
context-budget metadata to the plugin together with a cloned model-facing
message list. TST protocol `cuppet.tst.v2` atomically observes bounded completed
turns and returns relevant/recent STM, verified LTM, graph locations, and
one-hop relationships. History selection is adaptive and affects only that
clone; OpenCode's transcript, permission state, tool loop, undo boundaries, and
native compaction records are never rewritten by Cuppet.

The last pre-native Ink interface remains a behavioral regression baseline.
OpenCode owns visual styling, while Cuppet tests composer visibility, terminal
resize, transcript continuity, Markdown tables, Mermaid fallback, diffs,
questions, permissions, model/effort sequencing, and slash-command visibility
against the behavior that users relied on before the migration.
