# PE3 issue #9 acceptance coverage

- Deterministic routing remains the normal hot path; semantic inference is only entered from `semanticEligible` ambiguity.
- Incoming prompts are embedded exactly once per semantic routing decision.
- TST graph localization runs before semantic inference when available.
- Task identity uses a bounded weighted fingerprint where touched/tool evidence outranks prompt mentions and weak signals decay.
- Dormant semantic matches are evaluated before novelty/new-agent creation.
- Dormant reactivation requires both an absolute match threshold and active/runner-up margins.
- Novel task creation requires low similarity to every known task; middling/close semantic evidence preserves the active task.
- Local embedding/model failures return `continue` and are observable in PE3 routing telemetry.
- Telemetry records localization queries/hits, semantic escalation count, model ID, prompt/agent embedding counts, cumulative/max embedding latency, fallback/failure counts, and last active/dormant similarities.
- Benchmark detected-arm turns expose semantic similarities, dormant-active margin, model ID, and embedding latency through `semanticCalibrationRows()` for offline threshold sweeps.
- Tests cover vocabulary-gap continuations, natural no-cue switches, generic-vocabulary adversarial switches, close-margin false-split resistance, dormant reactivation, TST localization, model failure fallback, prompt-once embedding, fingerprint weighting, and the natural `A → A → B → B → C → A` corpus.
