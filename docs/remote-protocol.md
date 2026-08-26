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

`seq` is monotonic for one host authority. `host.attach`, `client.accept`, and
`client.reject` are control frames and always use `seq: 0`; they do not move
the event cursor. `host.attach.payload.connectionId` changes when the host
process is replaced, so clients reset their sequence cursor before applying
the new authority's snapshot. Clients skip `seq <= lastSeq` (relay replay)
and request a resnapshot when a gap is detected.

## Handshake

```text
ws://…/ws?role=host&hostId=…&secret=…
ws://…/ws?role=device&hostId=…&deviceId=…
```

A device sends either `device.pair {code, name}` or
`device.hello {deviceId, secret}` after the socket opens. Pairing returns
`replyTo: "device-pair"` with `{deviceId, secret, scopes}`; codes are
single-use with a 2-minute TTL. After a successful hello the host sends
`client.accept`, then `host.attach`.

When managed credentials are enabled, Sydney mints a five-minute EdDSA JWT
bound to the user, host, device, and scopes. Sydney keeps the Ed25519 private
key; authenticated host enrollment delivers the matching public key to
Cuppet-code, which verifies tokens locally. The relay only transports the JWT
and never verifies or stores a signing secret. The host drops the device when
the JWT expires. Host-local pairing credentials remain supported for
self-hosted deployments without managed tokens.

The relay is a trusted transport, not an end-to-end-encrypted boundary: it can
observe handshake payloads and live envelopes. Run it behind TLS and never
send provider API keys through it.

Relay close codes: `4001` host offline · `4002` host unauthorized ·
`4003` invalid device.

## First-time mobile setup

When Cuppet-code has no `CUPPET_TOKEN` and no manually configured
`CUPPET_RELAY_URL`, `cuppet remote-control` starts a short-lived account-link
session with Sydney and prints a `cuppet://remote/setup?...` QR. The QR contains
only the setup id and one-time code. The CLI keeps a separate polling secret in
memory and never prints it.

The signed-in Cuppet app scans the QR, previews the machine, and asks the user
to confirm. Sydney then associates the host with that account. The CLI polls
the setup session, submits its local relay secret over HTTPS, and receives the
relay URL plus the Ed25519 verification key. Only after that enrollment does
the host dial the relay. The provider credentials remain on the computer.

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
| `diff.updated` | `{diff: string}` unified diff text |
| `permission.requested` / `permission.resolved` | `{request}` / `{requestID, reply?}` |
| `question.requested` / `question.resolved` | `{request}` / `{requestID, accepted}` |
| `usage.updated` | `{usage:{input,output}, cost}` |
| `session.idle` / `session.updated` | `session.updated` adds `{sessionID, agent?}` |
| `compaction`, `step.limit`, `agent.error` | |
| `device.paired`, `client.accept`, `client.reject`, `bridge.error` | transport-level |

Unknown event types and unknown commands **fail closed**: unknown commands get
an error reply; unknown events are ignored by the client but still advance `seq`.
