# PE3 restart persistence

Issue #10 makes task-local routing identity survive Cuppet process restarts without duplicating OpenCode conversation state.

## Storage boundary

Each workspace writes one private registry at:

```text
<projectStore>/pe3-task-agents.json
```

`projectStore` is already keyed by the SHA-256 identity of the workspace realpath, so registries are project-scoped. The file is written atomically with mode `0600`; its parent project directory is already private (`0700`).

The registry is capped at 32 most-recent task agents and stores routing metadata only:

- OpenCode session ID
- bounded/redacted task descriptor
- active/touched paths
- recent symbols and bounded terms
- weighted task fingerprint
- stale paths
- cache/workspace epochs
- created/last-active timestamps and turn count
- lightweight file signatures for currently privileged paths

It does **not** store transcripts, assistant messages, tool output, provider prompts, credentials, or semantic embedding vectors. Routing strings are passed through the existing secret redactor before disk; secret-bearing term/path-like values are omitted.

## Restore sequence

On controller startup:

1. OpenCode is initialized normally.
2. PE3 lists the existing project sessions without prompting a model.
3. The persisted registry is loaded and reconciled against those session IDs.
4. Missing/deleted session references are dropped.
5. Dormant task identities are reconstructed as inert router state.
6. The actual currently active OpenCode session is activated last.
7. The reconciled bounded registry is written back, eventually removing deleted-session entries from disk.

Missing or malformed JSON returns an empty registry and never blocks Cuppet startup.

## Offline workspace changes

At save time PE3 records `size`, `mtimeMs`, and mode for bounded active/touched paths. On restore those signatures are compared with current filesystem metadata.

If a path changed or disappeared while Cuppet was offline:

- it is removed from restored active/touched path privilege;
- its weighted path fingerprint entry is removed;
- it is marked stale;
- cache/workspace epoch metadata advances;
- the next prompt delivered to that restored task receives a bounded refresh instruction naming the stale paths.

The stale guard remains until current tool evidence reports the path again. This means persisted file identity can never silently override current workspace truth.

## Semantic compatibility

Issue #9's semantic vectors remain an in-memory cache. They are intentionally **not** persisted by issue #10. After restart they are lazily regenerated from the restored bounded descriptor/fingerprint using the currently configured local embedding model.

Therefore an embedding model/version change cannot cause an old incompatible vector to be trusted after restart.

## Failure behavior

Persistence is an optimization for routing continuity, not a startup dependency:

- missing registry -> fresh PE3 state;
- corrupt/unsupported registry -> fresh PE3 state with recovery telemetry;
- missing OpenCode session -> ignore/drop that task entry;
- stat/signature failure -> treat the affected path conservatively as unavailable/stale;
- registry write failure -> keep the running in-memory router and increment telemetry;
- restore itself performs no semantic/foreground/background model inference.
