# PE3 task-local routing

PE3 treats task discontinuity as a context-isolation event rather than a reason to continuously minimize the prompt.

## Invariants

- Related and ambiguous follow-ups stay on the active OpenCode session so its provider-cache prefix remains reusable.
- Routing is deterministic and model-free on the hot path.
- Only strong task mismatch can leave the active task agent.
- A matching dormant task session is reactivated before a new task session is created.
- Dormant sessions do not execute models simply because they exist.
- Project/global TST memory and graph state remain shared; active/touched paths, recent symbols, stale paths, and cache epochs remain task-local.
- Workspace mutations invalidate file-specific privilege in dormant agents. A reactivated task receives a bounded refresh hint before relying on stale paths.
- Native TUI prompts are routed by the bundled OpenCode derivative before inference. A routed source turn is `noReply` and stores only a routing marker; the full request is forwarded to the target task session.
- Non-text native prompts are deliberately not rerouted so attachments are never dropped or reconstructed incorrectly.
- Cuppet-submitted prompts use a one-shot native-routing bypass to avoid double routing when they enter the bundled OpenCode server.
- Cached input, uncached input, output/reasoning tokens, provider-calculated cost, and turn latency are accumulated across task-local sessions.

## Routing benchmark

Run:

```sh
npm run eval:pe3:routing
```

The default persistent sequence is `A → A → B → B → C → A` and compares:

1. current single-session behavior
2. cache-preserving PE3 without routing
3. oracle task boundaries
4. detected PE3 routing

The routing-only run measures false splits, missed switches, and switch behavior. To attach real provider/task outcomes, set `CUPPET_PE3_BENCHMARK_TRACE` to a JSON object keyed by benchmark arm. Per-turn outcome records can include success, first-pass success, retries, stale-context incidents, cached/uncached input, output tokens, provider-adjusted effective cost, and latency.

Raw input-token count is not treated as the primary efficiency metric. Cache reuse and provider-calculated effective cost are reported separately.
