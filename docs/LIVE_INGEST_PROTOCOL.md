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
- Reply on refusal: `{"type": "error", "code": "<code>"}`. A second `hello` on the same socket gets
  `already_open`. A `hello` for a session that was already saved gets `session_closed`.

### `batch` (device to bridge)

```json
{"type": "batch", "seq": 7, "events": [{"tMs": 1200, "category": "CHUNK", "event": "Loaded", "details": {}}]}
```

- Requires a successful `hello` on the same socket. Otherwise: `{"type": "error", "code": "no_session"}`.
- `seq` is a device-chosen number. The bridge echoes it.
- Reply: `{"type": "ack", "seq": 7}`. The ack means the events of that batch were accepted into the
  live session.
- The ack covers only the events the session accepted: `{"type": "ack", "seq": 7, "accepted": 24}`.
  An event is refused when it is not an object with a numeric `tMs` and string `category` and `event`,
  or when the session is at its event limit. Refused events are not saved and not broadcast.
- A `seq` seen before is refused with `{"type": "error", "code": "duplicate_seq", "seq": 7}`, with no
  ack, and the batch's events are dropped.
- A jump in `seq` is accepted, and the skipped numbers are recorded in the saved header as
  `seqGaps`, for example `[[2, 3]]` when seq 1 is followed by seq 4.

### `bye` (device to bridge)

```json
{"type": "bye"}
```

- Ends the live session. Reply: `{"type": "bye", "status": "ok", "saved": true}`. If the file could not
  be written, the reply is `{"type": "bye", "status": "save_failed", "saved": false}`.
- The bridge saves the session as `<sessionId>.json` in the upload folder. It does this on `bye`, when the
  socket closes without a `bye`, and when the session has had no accepted events for 5 minutes. A session
  is saved once. An existing file with the same session id is never overwritten. After a failed save the
  bridge tries again on disconnect or on the next stale check.
- A session that is already saved refuses further batches with `session_closed`.

### Unknown types

`{"type": "error", "code": "unknown_message_type"}`.

## Error codes

| Code | Meaning |
|---|---|
| `unauthorized` | Token missing or wrong while `EXOPROFILER_LIVE_TOKEN` is set. |
| `no_session` | `batch` or `bye` before a successful `hello`. |
| `unknown_message_type` | `type` is not one of the above. |
| `bad_message` | The message is JSON but not an object. |
| `already_open` | A second `hello` on a socket that already has a session. |
| `session_closed` | `hello` or `batch` for a session that was already saved. |
| `bad_seq` | `batch.seq` is missing or not an integer. |
| `duplicate_seq` | `batch.seq` was already accepted on this session. |
| `bad_events` | `batch.events` is not a list. |
| (other) | Returned by `create_session` for an invalid session (for example `session_limit_reached`). |

## Viewer channel (bridge to dashboard)

- Any other path on 9090 is the viewer. The bridge sends each accepted batch's events to viewers as
  `{"type": "events", "sessionId": "<id>", "events": [...]}`.
- **Current behaviour (to fix, 1.21):** the viewer channel also re-broadcasts anything a viewer sends,
  and it does not check `Origin`. Viewers must not be trusted to send data. Planned: viewer messages
  are ignored, and `Origin` is checked on every path.

## Limits

- A live session holds its accepted events in memory until it is saved. The bridge's limit is
  `max_events` in the session config (default 200000). The SDK's own file cap is `maxEventsPerSession`
  (default 10000), which the bridge does not apply.
- The viewer buffer (`live_events_buffer`) is not used by ingest. Ingest events reach viewers only
  as `events` messages.

## Relation to the saved file

A live session written by the bridge has the same v3 layout as a file written by the SDK
(`schemaVersion`, `session`, `events`, `aggregates`, `hash`). Its `session` header also has:

- `source`: `"live"`.
- `endReason`: `"bye"`, `"disconnect"` or `"stale"`.
- `seqGaps` and `rejectedBatches`, from the batch rules above.

The `aggregates` are computed by the bridge with the same rules as the SDK, and they do not depend on
event order. The `hash` is the first 12 hex characters of SHA-256 over the canonical JSON of the
document without `hash` (sorted keys, no spaces). It is the bridge's own digest, so it is not
comparable to the SDK's `hash`, which covers the SDK's exact bytes.
