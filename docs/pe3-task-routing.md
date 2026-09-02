# PE3 task-local routing

PE3 treats task discontinuity as a context-isolation event rather than a reason to continuously minimize the prompt.

## Invariants

- Related and ambiguous follow-ups stay on the active OpenCode session so its provider-cache prefix remains reusable.
- Routing remains deterministic and model-free on the normal hot path.
- A narrow vocabulary-gap band may escalate first to local TST graph localization and then to a small local sentence-embedding model.
- The semantic stage embeds the incoming prompt once, compares it with compact active/dormant task fingerprints, and never calls a remote inference/LLM routing API.
- Low-confidence semantic evidence and embedding failures fall back to the active task instead of forcing a split.
- Dormant task fingerprints are checked before semantic novelty can create another task-local session.
- A matching dormant task session is reactivated before a new task session is created.
- Dormant sessions do not execute models simply because they exist.
- Project/global TST memory and graph state remain shared; task fingerprints, active/touched paths, recent symbols, stale paths, and cache epochs remain task-local.
- Workspace mutations invalidate file-specific privilege in dormant agents. A reactivated task receives a bounded refresh hint before relying on stale paths.
- Native TUI prompts are routed by the bundled OpenCode derivative before inference. A routed source turn is `noReply` and stores only a routing marker; the full request is forwarded to the target task session.
- Non-text native prompts are deliberately not rerouted so attachments are never dropped or reconstructed incorrectly.
- Cuppet-submitted prompts use a one-shot native-routing bypass to avoid double routing when they enter the bundled OpenCode server.
- Cached input, uncached input, output/reasoning tokens, provider-calculated cost, turn latency, semantic escalation count, embedding latency, fallback count, and embedding failure count are accumulated across task-local sessions.

## Weighted task fingerprint

Task identity is based on what the task actually did, not every word it ever mentioned. Fingerprint evidence is bounded and weighted approximately by trust/activity:

- touched/modified paths: strongest
- observed active/read paths and recent tool symbols: strong
- TST graph-localized paths/symbols: medium
- prompt-mentioned paths/symbols: weaker
- lexical terms: weakest

Weak signals decay as turns advance. This keeps incidental vocabulary from permanently owning a task while preserving concrete working-set identity.

The fingerprint contains only compact descriptors/artifacts/symbols/terms. It is not a transcript copy and it is not durable project LTM.

## Natural switch escalation

For a normal continuation or a deterministic path/symbol match, PE3 never loads the embedding runtime.

For an otherwise substantive ambiguous prompt:

```text
prompt
  ↓
deterministic affinity
  ↓ ambiguous
local TST graph localization
  ├─ concrete active match → stay
  ├─ concrete dormant match → reactivate
  ├─ concrete disjoint task → create/reactivate
  └─ still ambiguous
         ↓
small local embedding model
         ↓
active + dormant fingerprint similarities
         ├─ decisive dormant winner → reactivate
         ├─ strong active match → stay
         ├─ low similarity to every known task → create
         └─ low confidence / close race / failure → stay
```

The default runtime uses `@huggingface/transformers` with `Xenova/all-MiniLM-L6-v2` as a provisional small sentence-embedding model. Model choice and thresholds are intentionally swappable; benchmark calibration should decide whether this remains the best default.

Environment controls:

- `CUPPET_PE3_EMBED_MODEL` — override model ID.
- `CUPPET_PE3_MODEL_CACHE` — override Transformers model cache.
- `CUPPET_PE3_MODEL_DIR` — point at pre-staged local model assets.
- `CUPPET_PE3_ALLOW_MODEL_DOWNLOAD=0` — strict offline mode; if assets are absent, routing safely falls back to the active task.

Model assets may be fetched into the local cache when downloads are allowed, but routing inference itself is local. There is no remote classifier/LLM decision call.

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

Detected-arm benchmark turns also expose semantic active similarity, best dormant similarity/margin, model ID, and embedding latency whenever the semantic band is entered. `semanticCalibrationRows()` converts those turns into compact rows for Issue #4/offline threshold sweeps. The production thresholds are constructor-level policy, not learned online; false-split minimization should remain the primary calibration constraint.

Raw input-token count is not treated as the primary efficiency metric. Cache reuse and provider-calculated effective cost are reported separately.
