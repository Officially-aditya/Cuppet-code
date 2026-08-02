# Cuppet OpenCode patch stack

These patches are intentionally numbered and applied in order to a detached
worktree of OpenCode `1.18.4` at revision
`49c69c5ed3ccf706b61b3febb43c8aaff7f8325e`. The build refuses to continue when
the revision, patch context, or patch digest changes. The source files added by
the stack carry the derivative implementation units and identity marker used by
the corresponding native Solid/OpenTUI changes in the derived source checkout;
they are kept here so the patch boundary remains auditable and easy to rebase.

`0005-cuppet-home-wordmark.patch` replaces the native home-page OPEN/CODE
wordmark with the Cuppet CUP/PET wordmark while preserving the upstream logo
renderer, sizing behavior, and theme colors.

`0006-cuppet-session-epilogue.patch` applies the same Cuppet wordmark and
`cupet -s` resume command to terminal scrollback and session-exit summaries.

`0007-cuppet-status-command.patch` reserves the native `opencode.status`
command ID and `/status` slash name for Cuppet's runtime, model, background,
memory, and TST status action while hiding the superseded upstream dialog.

`0008-cuppet-permission-recovery.patch` keeps native permission prompts reliable
when the attached TUI misses an SSE event. Pending requests are reconciled from
the private server while a session is active; Cuppet never auto-approves them.

`0009-cuppet-model-context-hook.patch` gives Cuppet a request-scoped,
model-facing clone of foreground history together with the active session,
agent, model, phase, and context budget. Native persistence and tool processing
continue to use the untouched message list.

`0015-cuppet-stm-only-compaction.patch` carries the opt-in STM-only compaction
directive through the request-scoped hook. A successful directive is written
through the native compaction-record path without summary-model generation;
refresh failures stop before transcript mutation. With the flag disabled, the
native summarization path remains unchanged.

`0010-cuppet-model-effort-dialog.patch` preserves the pre-migration selection
sequence: choosing any model with advertised effort variants always opens the
native effort dialog, even when the previous effort remains compatible.

`0011-cuppet-native-mermaid.patch` connects compact Cuppet flowchart rendering
to OpenTUI's actual transcript renderer. Unsupported Mermaid remains the
original fenced source without data loss; Markdown tables continue through the
native grid renderer.

`0012-cuppet-canonical-command-tips.patch` keeps home-page guidance on the
canonical Cuppet slash commands instead of hidden helper action names.

`0013-cuppet-permission-json-boundary.patch` normalizes pending permission
metadata before SSE/HTTP delivery so optional tool fields cannot suppress the
native dialog. It also keeps reconciliation polling bounded while a turn is
active.

`0014-cuppet-native-plan-mode.patch` exposes native agent current/set
operations to the Cuppet TUI plugin, makes `/plan` switch directly between
plan and build, and adds the reactive warning-colored `Plan mode` footer label.
The label is derived from the native agent store, so it remains correct across
session switching and terminal resizing.
