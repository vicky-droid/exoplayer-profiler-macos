# Live ingest protocol (WebSocket, device to bridge)

This describes the protocol the bridge accepts today, with the planned changes marked **(planned)**.
Items 1.8 (SDK LiveSink) and 1.9 (bridge persistence) must follow this note.

## Endpoint

- `ws://<bridge-host>:9090/ingest`. Any other path on 9090 is the viewer channel, not ingest.
- Messages are JSON text frames. Every message has a `type` field.

## Messages

### `hello` (device to bridge)

```json
{"type": "hello", "token": "<optional>", "sessionId": "<uuid>", "schemaVersion": 3,
 "redacted": true, "device": {"manufacturer": "...", "model": "..."}, "config": {}}
```

- `token`: checked only when the bridge has `EXOPROFILER_LIVE_TOKEN` set. Wrong or missing token gets
  `{"type": "error", "code": "unauthorized"}` and the socket closes.
  **(planned, 1.2)** The token moves to the `Authorization: Bearer <token>` header on the upgrade
  request. The body field is accepted for one release during migration.
- `sessionId`: required. The bridge also accepts `session.id`.
- Reply: `{"type": "hello", "status": "ok", "sessionId": "<id>"}`.
- Reply on refusal: `{"type": "error", "code": "<code>"}`.

### `batch` (device to bridge)

```json
{"type": "batch", "seq": 7, "events": [{"tMs": 1200, "category": "CHUNK", "event": "Loaded", "details": {}}]}
```

- Requires a successful `hello` on the same socket. Otherwise: `{"type": "error", "code": "no_session"}`.
- `seq` is a device-chosen number. The bridge echoes it.
- Reply: `{"type": "ack", "seq": 7}`. The ack means the events of that batch were accepted into the
  live session.
- Current behaviour: every event is accepted and the ack is always sent, even if the session
  refuses an event. **(planned, 1.9)** The ack covers only the events the session accepted. A duplicate
  `seq` is rejected, and a gap in `seq` is recorded in the saved session header.

### `bye` (device to bridge)

```json
{"type": "bye"}
```

- Ends the live session. Reply: `{"type": "bye", "status": "ok"}`.
- **(planned, 1.9)** The bridge writes `<sessionId>.json` on `bye`, and also when the socket
  disconnects without a `bye`, and when an idle session goes stale. Each file is written once.

### Unknown types

`{"type": "error", "code": "unknown_message_type"}`.

## Error codes

| Code | Meaning |
|---|---|
| `unauthorized` | Token missing or wrong while `EXOPROFILER_LIVE_TOKEN` is set. |
| `no_session` | `batch` or `bye` before a successful `hello`. |
| `unknown_message_type` | `type` is not one of the above. |
| (other) | Returned by `create_session` for an invalid session (for example an empty id). |

## Viewer channel (bridge to dashboard)

- Any other path on 9090 is the viewer. The bridge sends each accepted batch's events to viewers as
  `{"type": "events", "sessionId": "<id>", "events": [...]}`.
- **Current behaviour (to fix, 1.21):** the viewer channel also re-broadcasts anything a viewer sends,
  and it does not check `Origin`. Viewers must not be trusted to send data. Planned: viewer messages
  are ignored, and `Origin` is checked on every path.

## Limits

- Batches are capped by the transport. The SDK keeps at most 3000 buffered events per session on the
  bridge side (`live_events_buffer` is the viewer buffer; **(planned, 1.9)** ingest no longer uses it).
- A session holds at most `maxEventsPerSession` events (default 10000) before the file is capped.

## Relation to the saved file

A live session written by the bridge has the same v3 layout as a file written by the SDK
(`schemaVersion`, `session`, `events`, `aggregates`, `hash`). The bridge does not yet fill `hash`
for live sessions **(planned, 1.9)**.
