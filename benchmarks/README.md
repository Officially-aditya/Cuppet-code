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
  Cuppet primary model is used. Set `CUPPET_AB_VARIANT=low` (or another live
  provider variant) when the selected model exposes an effort variant.
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

## Task Tracker refactor benchmark

Run the graph-sensitive cross-file refactor with five paired repeats:

```bash
CUPPET_TTT_ALLOW_EXTERNAL=1 \
CUPPET_TASK_TRACKER_REPEATS=5 \
npm run eval:ab:task-tracker
```

The seeded fixture is `games/task-tracker/` and contains 14 files. It starts
with a `Task.dueDate` field, roughly ten cross-file usage sites, an intentional
store defect, and the observable path:

```text
cli/commands.ts → api/routes.ts → api/handlers.ts → store/taskStore.ts
```

The agent must rename the field to `deadline`, update validation to reject past
deadlines, and fix the defect at the store rather than patching only the CLI
output. The hidden suite is generated in a private temporary directory outside
each trial workspace. It checks legacy-token removal, past/future validation,
direct store preservation, and CLI-to-API-to-store preservation. It also runs
the fixture tests, typecheck, and CLI help smoke test.

Acceptance is reported in three groups:

- `hop≤1`: rename coverage plus past-deadline validation.
- `hop2`: direct store preservation plus the CLI/API/store propagation path.
- `regression`: focused tests, typecheck, and CLI smoke.

The authoritative five-repeat report is
[`ab-task-tracker-2026-07-23T03-21-57.074Z.md`](results/ab-task-tracker-2026-07-23T03-21-57.074Z.md),
with raw session data in
[`ab-task-tracker-2026-07-23T03-21-57.074Z.json`](results/ab-task-tracker-2026-07-23T03-21-57.074Z.json).
The first five-pair run was discarded after an evaluator overconstraint was
found and removed; the linked report is from the corrected rerun.

On the corrected run, OpenCode completed 5/5 trials and Cuppet completed 2/5.
Cuppet's all-trial median latency and cost were 68.8% and 68.4% lower, but
its hop≤1 acceptance was 50.0% versus OpenCode's 100.0%, and hop2 acceptance
was 40.0% versus 100.0%. Among successful completions only, Cuppet was slower
and more expensive, so early incomplete sessions must not be interpreted as
successful-task efficiency.

The harness is [`scripts/ab-task-tracker.ts`](../scripts/ab-task-tracker.ts).
It records all permissions and requires `CUPPET_TTT_ALLOW_EXTERNAL=1` to avoid
turning approved external-directory discovery into a Cuppet-only failure.
