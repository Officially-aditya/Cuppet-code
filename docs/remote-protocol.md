# Cuppet Remote Protocol v1

Frozen contract between Cuppet mobile/web clients and the cuppet-code host,
carried over the relay. The relay routes envelopes; the **host** is the
authority for every command; clients render semantic events only.

## Invariants

- Backend performs zero coding inference and never sees provider keys.
- Every command is scope-checked on the host per message (`ControlActor`).
- Command ids are replay-safe: hosts keep an LRU of processed ids.
- Frames are JSON, capped at 512 KiB.

## Envelopes

```jsonc
// host → device events
{ "version": 1, "seq": 12, "hostId": "host_…", "ts": 1787…, "type": "…", "payload": { … }, "sessionId": "ses_…" }

// device → host commands
{ "version": 1, "id": "c-123", "ts": 1787…, "type": "…", "payload": { … } }

// replies
{ "version": 1, "replyTo": "c-123", "ok": true, "result": { … } }
{ "version": 1, "replyTo": "c-123", "ok": false, "error": "…" }
```

`seq` is monotonic for one host authority. `host.attach.payload.connectionId`
changes when the host process is replaced, so clients reset their sequence
cursor before applying the new authority's snapshot. Clients skip
`seq <= lastSeq` (relay replay) and request a resnapshot when a gap is
detected.

## Handshake

```text
ws://…/ws?role=host&hostId=…&secret=…
ws://…/ws?role=device&hostId=…&deviceId=…[&secret=…]
```

A device connection **without** `secret` is a pairing socket: it sends
`device.pair {code, name}` and receives `replyTo: "device-pair"` with
`{deviceId, secret, scopes}`. Codes are single-use, 2-minute TTL.
On connect the host broadcasts `client.accept`/`client.reject`, then
`host.attach`.

When managed credentials are enabled, Sydney mints a five-minute JWT bound to
the user, host, device, and scopes. The host verifies it locally using
`CUPPET_REMOTE_TOKEN_SECRET`; the relay only transports it and never verifies
or stores it. Host-local pairing credentials remain supported for self-hosted
deployments without the shared secret.

Relay close codes: `4001` host offline · `4002` host unauthorized ·
`4003` invalid device.

## Attach

```jsonc
{ "type": "host.attach", "payload": {
    "connectionId": "…",
    "protocolVersion": 1, "minimumClientVersion": 1,
    "snapshot": { …ControllerSnapshot… },
    "permissions": [ {id, sessionID} ], "questions": [ … ] } }
```

Clients whose supported version is below `minimumClientVersion` must show
"Update Cuppet-code" and stop.

## Commands → scopes

| Command | Scope | Payload / result |
| --- | --- | --- |
| `host.get` | session.read | → `{hostId,name,platform,version,protocolVersion,online,connectedAt,workspace,provider:{configured,ready,selectedProvider,selectedModel}}` |
| `workspace.list` | session.read | → `[ {workspaceId,name,pathDisplay,activeSessionId} ]` |
| `workspace.attach` | session.write | `{workspaceId?}` → workspace info + `attached:true` |
| `session.list` | session.read | → sessions |
| `session.snapshot` | session.read | → ControllerSnapshot |
| `session.messages` | session.read | `{sessionID}` → messages |
| `permission.list` | session.read | → pending permissions |
| `question.list` | session.read | → pending questions |
| `model.list` | session.read | → models from snapshot |
| `agent.mode.get` | session.read | → `{mode:"build"\|"plan"}` |
| `session.new` | session.write | |
| `session.resume` | session.write | `{sessionID}` |
| `session.submit` | session.write | `{prompt, delivery:"queue"\|"steer"}` |
| `session.steer` | session.write | `{instruction}` |
| `session.abort` | session.write | |
| `session.undo` | session.write | |
| `session.compact` | session.write | |
| `plan.set` / `agent.mode.set` | session.write | `{agent:"plan"\|"build"}` |
| `permission.reply` | permission.write | `{request:{id,sessionID}, reply:"once"\|"always"\|"reject"}` |
| `question.reply` | question.write | `{requestID, answers: string[][]}` — one array per question |
| `question.reject` | question.write | `{requestID}` |
| `model.select` | model.write | `{providerID, modelID, role?, variant?}` |

Local-only (`status`, `doctor`, memory, platform wiring) never crosses the wire.

## Events

| Type | Payload |
| --- | --- |
| `assistant.text.delta` / `assistant.reasoning.delta` | `{text}` |
| `tool.started` / `tool.progress` / `tool.completed` | `{callID,…}`, completed adds `{success, diff?}` |
| `diff.updated` | `{diff}` |
| `permission.requested` / `permission.resolved` | `{request}` / `{requestID, reply?}` |
| `question.requested` / `question.resolved` | `{request}` / `{requestID, accepted}` |
| `usage.updated` | `{usage:{input,output}, cost}` |
| `session.idle` / `session.updated` | |
| `compaction`, `step.limit`, `agent.error` | |
| `device.paired`, `client.accept`, `client.reject`, `bridge.error` | transport-level |

Unknown event types and unknown commands **fail closed**: unknown commands get
an error reply; unknown events are ignored by the client but still advance `seq`.
