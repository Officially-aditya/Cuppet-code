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
