# Cuppet A/B evaluation

Run the paired evaluation with:

```bash
npm run eval:ab
```

The harness starts the pinned official OpenCode server once and creates a fresh
session for each arm. Plain OpenCode receives the original task. Cuppet receives
the same task prefixed with its bounded, injection-labelled TST retrieval block.
The model, agent rules, tools, permissions, project, and server process are
otherwise identical. Arm order alternates to reduce provider-cache ordering
bias. Unexpected mutation and shell permissions are rejected because the pilot
suite is read-only.

Metrics come from OpenCode session records. `tokens.input` is treated as
uncached input because OpenCode reports cache reads and writes as separate
counters. Medians for tokens, latency, and cost are calculated only over
successful tasks; completion rate includes every trial.

Environment controls:

- `CUPPET_AB_MODEL=provider/model` selects a model; otherwise the configured
  Cuppet primary model is used.
- `CUPPET_AB_LIMIT=N` runs the first N task pairs for a low-cost pilot.

This five-task suite measures code navigation and retrieval. It is a smoke
benchmark, not sufficient evidence for the public 20% efficiency claim. A
release claim still requires a larger multi-turn edit-and-validation suite,
repeated runs, and confidence intervals.

## Tic-Tac-Toe coding benchmark

Run the paired multi-turn coding task with:

```bash
npm run eval:ab:tic-tac-toe
```

The coding harness gives OpenCode and Cuppet the same Tic-Tac-Toe brief and
model, alternating arm order across fresh isolated copies of this repository.
Both arms can read, search, edit, write, and run project-local validation. The
Cuppet arm additionally receives its bounded TST retrieval block. The harness
then runs hidden engine checks, the agent's focused test script, typecheck, and
CLI `--help` smoke validation.

It reports completion rate, acceptance score, latency, uncached input tokens,
total model tokens, tool calls, cost, and cost/token efficiency. Set
`CUPPET_TTT_REPEATS=N` for 1–5 paired repeats, `CUPPET_AB_MODEL=provider/model`
to select a model, and `CUPPET_TTT_KEEP_WORKSPACES=1` to retain trial copies
for inspection. If a run needs OpenCode's explicit external-directory
discovery permission, set `CUPPET_TTT_ALLOW_EXTERNAL=1` after reviewing the
requested resources. Results are written to `benchmarks/results/`.
