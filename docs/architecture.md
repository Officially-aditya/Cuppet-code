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
interface. Context retrieval is delivered as an ephemeral synthetic prompt part
while the ordinary persisted user message remains unchanged.

The pinned derivative passes request-scoped session, agent, model, phase, and
context-budget metadata to the plugin together with a cloned model-facing
message list. TST protocol `cuppet.tst.v3` atomically observes bounded completed
turns and returns relevant/recent STM, verified LTM, query-specific graph
locations, one-hop relationships, and—only for plan mode—a deterministic,
ephemeral workspace projection. The projection compresses every indexed path
into a directory tree, de-duplicates import/export/implementation/test module
dependencies, and selects important top-level/exported symbol signatures with
locations. It reports indexed and included totals plus omissions; unfinished
indexing or budget truncation is always incomplete. Plan context receives up to
12% of usable model context, capped at 16K tokens, allocated 70% to the
projection, 15% to query graph, 10% to STM, and 5% to verified LTM. Build and
other foreground agents retain the smaller context path. A complete projection
instructs plan mode to use the map and blocks explorer task calls; an incomplete
projection or unavailable TST explicitly preserves explorer fallback.
History selection is adaptive and affects only that clone; OpenCode's
transcript, permission state, tool loop, undo boundaries, and native compaction
records are never rewritten by Cuppet. Projection state is bounded per session
and cleared on agent changes, compaction, disposal, and eviction.

The native `/plan` command switches directly between the current native plan and
build agents and synchronizes Cuppet's controller through `plan.set`; it does
not open the agent picker. The derived footer reacts to the native agent and
shows the warning-colored text `Plan mode` only while plan is current, including
after terminal resizing and session switching.

The last pre-native Ink interface remains a behavioral regression baseline.
OpenCode owns visual styling, while Cuppet tests composer visibility, terminal
resize, transcript continuity, Markdown tables, Mermaid fallback, diffs,
questions, permissions, model/effort sequencing, and slash-command visibility
against the behavior that users relied on before the migration.
