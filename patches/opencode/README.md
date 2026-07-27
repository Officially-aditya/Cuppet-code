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
