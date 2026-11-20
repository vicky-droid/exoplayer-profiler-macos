"""
Schema normaliser for ExoPlayer Profiler v4.

Detects and normalises all supported session formats into a single internal
shape used by both file-drop and bridge ingest paths.

Supported formats:
  - Schema v3:  schemaVersion >= 3, uses tMs/wallMs/category/event/details
  - Schema v2:  timeMs/timestampMs/category/event/details (no session wrapper)
  - Rich upload: has aggregates/hash fields (rich server-side upload format)
  - Logcat-parsed: category/event keys with raw details (from logcat tailing)

Normalised internal shape:
  {
    "session": { ...session header... },
    "events":  [ {rel, wall, cat, event, details, kind}, ... ],
    "chunks":  [ {chunkId, ...}, ... ],
    "aggregates": { ...aggregates... }
  }
"""

import hashlib
import json
import logging
import os

logger = logging.getLogger(__name__)

# Schema version thresholds
SCHEMA_V3 = 3
SCHEMA_V2 = 2

# Media3 Player.STATE_BUFFERING. The SDK writes this number in PLAYBACK StateChanged details.
PLAYER_STATE_BUFFERING = 2


def is_valid_event(e):
    """True for an event the v3 layout can hold: an object with a numeric tMs and string category and event."""
    if not isinstance(e, dict):
        return False
    t = e.get('tMs')
    if isinstance(t, bool) or not isinstance(t, (int, float)):
        return False
    return isinstance(e.get('category'), str) and isinstance(e.get('event'), str)


def _as_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def aggregates_from_events(events):
    """Session totals from an event list, with the same rules as the SDK's AggregateTracker.

    The result does not depend on the order of the list: rebuffers are worked out from timestamps.
    A rebuffer is buffering that starts after the first frame. It ends at the next non-buffering state,
    or at the last event when the session ends while buffering.
    """
    category_counts = {}
    error = chunk = switch = drm = underruns = 0
    dropped = 0
    first_frame = None
    last_t = 0
    buffering_changes = []
    for e in events:
        category = e.get('category')
        name = e.get('event')
        details = e.get('details') if isinstance(e.get('details'), dict) else {}
        t = e['tMs']
        category_counts[category] = category_counts.get(category, 0) + 1
        last_t = max(last_t, t)
        if category == 'CHUNK':
            chunk += 1
        elif category == 'ERROR':
            error += 1
        elif category == 'DRM':
            drm += 1
        elif category == 'TRACKS' and name == 'Switch':
            switch += 1
        elif category == 'AUDIO' and name == 'Underrun':
            underruns += 1
        elif category == 'VIDEO':
            if name == 'RenderedFirstFrame':
                first_frame = t if first_frame is None else min(first_frame, t)
            elif name == 'DroppedFrames':
                dropped += _as_int(details.get('droppedFrames', 0))
        elif category == 'PLAYBACK' and name == 'StateChanged':
            buffering_changes.append((t, _as_int(details.get('state', -1)) == PLAYER_STATE_BUFFERING))

    rebuffer_count = 0
    rebuffer_total = 0
    open_since = None
    for t, buffering in sorted(buffering_changes, key=lambda c: c[0]):
        if buffering:
            if open_since is None and first_frame is not None and t >= first_frame:
                open_since = t
                rebuffer_count += 1
        elif open_since is not None:
            rebuffer_total += t - open_since
            open_since = None
    if open_since is not None:
        rebuffer_total += last_t - open_since

    return {
        'categoryCounts': category_counts,
        'errorCount': error,
        'chunkCount': chunk,
        'switchCount': switch,
        'drmCount': drm,
        'rebufferCount': rebuffer_count,
        'rebufferTotalMs': rebuffer_total,
        'droppedFrames': dropped,
        'audioUnderruns': underruns,
    }


def document_hash(doc):
    """First 12 hex characters of SHA-256 over the canonical JSON of the document without its hash.

    This is the bridge's own digest. It is not the SDK's hash, which covers the SDK's exact bytes.
    """
    body = {k: v for k, v in doc.items() if k != 'hash'}
    canonical = json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()[:12]


def detect_schema(events, raw=None):
    """
    Detect the schema version/format of a session.

    Returns one of: 'v3', 'v2', 'rich', 'logcat', 'unknown'
    """
    if not events:
        return 'unknown'

    # Check for v3: has schemaVersion >= 3
    if isinstance(events, dict):
        schema_version = events.get('schemaVersion')
        if schema_version is not None and int(schema_version) >= 3:
            return 'v3'
        if events.get('schema') == 'v3':
            return 'v3'

        # Check for rich upload: has aggregates/hash
        if 'aggregates' in events or 'hash' in events:
            return 'rich'

        # Could be v2 or logcat-parsed
        if 'events' in events:
            inner = events['events']
            if inner and isinstance(inner[0], dict):
                first = inner[0]
                if 'tMs' in first or 'wallMs' in first:
                    return 'v3'
                first_cat = str(first.get('category') or first.get('cat') or '').upper()
                if first_cat in ('VST', 'CHUNK'):
                    return 'v3'
                if 'timeMs' in first or 'timestampMs' in first:
                    return 'v2'
                if 'category' in first or 'event' in first:
                    return 'logcat'
            # Empty events list but has session key - assume v2
            if 'session' in events:
                return 'v2'
            return 'unknown'

        # Single event dict
        if 'tMs' in events or 'wallMs' in events:
            return 'v3'
        cat_single = str(events.get('category') or events.get('cat') or '').upper()
        if cat_single in ('VST', 'CHUNK'):
            return 'v3'

        return 'unknown'

    # events is a list - check first event
    if isinstance(events, list) and events:
        first = events[0]
        if isinstance(first, dict):
            if 'tMs' in first or 'wallMs' in first:
                return 'v3'
            if 'timeMs' in first or 'timestampMs' in first:
                return 'v2'
            if 'category' in first or 'event' in first:
                return 'logcat'

    return 'unknown'


def normalise_session(raw):
    """
    Normalise any supported session format into the internal shape.

    Returns:
        {
            'session': { session header fields },
            'events': [ {rel, wall, cat, event, details, kind}, ... ],
            'chunks': [ {...} ],
            'aggregates': { ... },
            'schema': 'v3'|'v2'|'rich'|'logcat',
            'redacted': bool,
            'source': 'live'|'upload'|'logcat'|'file'
        }
    """
    if raw is None:
        return _empty_session()

    schema = detect_schema(raw)

    if schema == 'v3':
        return _normalise_v3(raw)
    elif schema == 'v2':
        return _normalise_v2(raw)
    elif schema == 'rich':
        return _normalise_rich(raw)
    elif schema == 'logcat':
        return _normalise_logcat(raw)
    else:
        # Unknown schema - return as-is wrapped in minimal structure
        return _normalise_unknown(raw)


def _empty_session():
    return {
        'session': {
            'id': 'unknown',
            'packageName': 'unknown',
            'startedAtEpochMs': 0,
            'exportedAtEpochMs': 0,
            'durationMs': 0,
            'eventCount': 0,
            'redacted': False,
        },
        'events': [],
        'chunks': [],
        'aggregates': {},
        'schema': 'unknown',
        'redacted': False,
        'source': 'unknown',
    }


# Header fields the viewer needs that the SDK writes. They are passed through unchanged so a
# normalised session keeps the same counters, device and attributes as the file on the device.
V3_HEADER_PASSTHROUGH = (
    'sessionId', 'droppedEvents', 'fileErrors', 'recovered', 'attributes', 'device', 'config',
    'media3Version', 'sdkVersion', 'health', 'droppedByCategory', 'outOfSessionEvents',
    'cappedEventsCounted', 'operationCount',
)


def validate_session_document(raw):
    """Check the shape of a v3 session document before it is stored.

    Returns (ok, error). Only the fields the bridge depends on are checked; the rest is kept as sent.
    """
    if not isinstance(raw, dict):
        return False, "Session must be a JSON object"
    session = raw.get('session')
    if not isinstance(session, dict):
        return False, "Missing session header"
    sess_id = session.get('sessionId') or session.get('id')
    if not isinstance(sess_id, str) or not sess_id.strip():
        return False, "Missing session id"
    events = raw.get('events')
    if not isinstance(events, list):
        return False, "events must be a list"
    for i, e in enumerate(events):
        if not isinstance(e, dict):
            return False, f"events[{i}] is not an object"
        t = e.get('tMs')
        if not isinstance(t, (int, float)) or isinstance(t, bool):
            return False, f"events[{i}].tMs must be a number"
        if not isinstance(e.get('category'), str) or not isinstance(e.get('event'), str):
            return False, f"events[{i}] needs string category and event"
    return True, None


def _normalise_v3(raw):
    """Normalise schema v3 format."""
    session_raw = raw.get('session', {})
    events_raw = raw.get('events', [])
    chunks_raw = raw.get('chunks', [])
    aggregates_raw = raw.get('aggregates', {})

    session = {
        'id': session_raw.get('id', session_raw.get('sessionId', 'unknown')),
        'packageName': session_raw.get('packageName', 'unknown'),
        'startedAtEpochMs': session_raw.get('startedAtEpochMs', 0),
        'exportedAtEpochMs': session_raw.get('exportedAtEpochMs', 0),
        'durationMs': session_raw.get('durationMs', 0),
        'eventCount': session_raw.get('eventCount', 0),
        # A missing flag means the content is treated as redacted (1.18): never assume raw.
        'redacted': session_raw.get('redacted', True),
    }
    for key in V3_HEADER_PASSTHROUGH:
        if key in session_raw:
            session[key] = session_raw[key]

    events = []
    for e in events_raw:
        events.append(normalise_event(e))

    aggregates = raw.get('aggregates', {})

    return {
        'session': session,
        'events': events,
        'chunks': chunks_raw,
        'aggregates': aggregates,
        'schema': 'v3',
        'redacted': session.get('redacted', False),
        'source': 'upload',
    }


def _normalise_v2(raw):
    """Normalise schema v2 format (timeMs/timestampMs based)."""
    if isinstance(raw, dict):
        session_raw = raw.get('session', {})
        events_raw = raw.get('events', [])
    else:
        session_raw = {}
        events_raw = raw

    session = {
        'id': session_raw.get('id', session_raw.get('sessionId', 'unknown')),
        'packageName': session_raw.get('packageName', 'unknown'),
        'startedAtEpochMs': session_raw.get('startedAtEpochMs', 0),
        'exportedAtEpochMs': session_raw.get('exportedAtEpochMs', 0),
        'durationMs': session_raw.get('durationMs', 0),
        'eventCount': session_raw.get('eventCount', 0),
        'redacted': session_raw.get('redacted', False),
    }

    events = []
    for e in events_raw:
        events.append(normalise_event(e))

    return {
        'session': session,
        'events': events,
        'chunks': [],
        'aggregates': {},
        'schema': 'v2',
        'redacted': session.get('redacted', False),
        'source': 'upload',
    }


def _normalise_rich(raw):
    """Normalise rich upload format (has aggregates/hash)."""
    session_raw = raw.get('session', {})
    events_raw = raw.get('events', [])

    session = {
        'id': session_raw.get('id', session_raw.get('sessionId', 'unknown')),
        'packageName': session_raw.get('packageName', 'unknown'),
        'startedAtEpochMs': session_raw.get('startedAtEpochMs', 0),
        'exportedAtEpochMs': session_raw.get('exportedAtEpochMs', 0),
        'durationMs': session_raw.get('durationMs', 0),
        'eventCount': session_raw.get('eventCount', 0),
        'redacted': session_raw.get('redacted', False),
    }

    events = []
    for e in events_raw:
        events.append(normalise_event(e))

    aggregates = raw.get('aggregates', {})
    chunks = raw.get('chunks', [])

    return {
        'session': session,
        'events': events,
        'chunks': chunks,
        'aggregates': aggregates,
        'schema': 'rich',
        'redacted': session.get('redacted', False),
        'source': 'upload',
    }


def _normalise_logcat(raw):
    """Normalise logcat-parsed format."""
    events_raw = raw if isinstance(raw, list) else raw.get('events', [])

    events = []
    for e in events_raw:
        events.append(normalise_event(e))

    return {
        'session': {
            'id': 'live-adb',
            'packageName': 'live-adb',
            'startedAtEpochMs': 0,
            'exportedAtEpochMs': 0,
            'durationMs': 0,
            'eventCount': len(events),
            'redacted': False,
        },
        'events': events,
        'chunks': [],
        'aggregates': {},
        'schema': 'logcat',
        'redacted': False,
        'source': 'logcat',
    }


def _normalise_unknown(raw):
    """Normalise unknown schema - best effort."""
    if isinstance(raw, dict) and ('event' in raw or 'category' in raw or 'cat' in raw or 'tMs' in raw or 'rel' in raw):
        events_raw = [raw]
    else:
        events_raw = raw if isinstance(raw, list) else raw.get('events', [])

    events = []
    for e in events_raw:
        if isinstance(e, dict):
            events.append(normalise_event(e))
        else:
            events.append({
                'rel': 0, 'timeMs': 0, 'wall': 0, 'timestampMs': 0, 'cat': 'unknown', 'category': 'unknown', 'event': str(e),
                'details': {}, 'kind': 'UNKNOWN',
            })

    return {
        'session': {
            'id': 'unknown',
            'packageName': 'unknown',
            'startedAtEpochMs': 0,
            'exportedAtEpochMs': 0,
            'durationMs': 0,
            'eventCount': len(events),
            'redacted': False,
        },
        'events': events,
        'chunks': [],
        'aggregates': {},
        'schema': 'unknown',
        'redacted': False,
        'source': 'unknown',
    }


def normalise_event(e):
    """Normalise a single event to the internal shape."""
    if not isinstance(e, dict):
        return {
            'rel': 0, 'timeMs': 0, 'wall': 0, 'timestampMs': 0, 'cat': 'unknown', 'category': 'unknown', 'event': str(e),
            'details': {}, 'kind': 'UNKNOWN',
        }

    # Determine time (rel = ms since session start)
    tMs = e.get('tMs')
    timeMs = e.get('timeMs')
    timestampMs = e.get('timestampMs', e.get('wallMs', 0))

    rel = tMs if tMs is not None else (timeMs if timeMs is not None else (e.get('rel', 0)))
    wall = timestampMs if timestampMs is not None else 0

    # Determine category and event names
    cat = e.get('category', e.get('cat', 'unknown'))
    event = e.get('event', e.get('ev', 'unknown'))

    # Determine content kind
    kind = e.get('kind', 'UNKNOWN')
    if kind == 'UNKNOWN':
        # Infer from category
        cat_upper = str(cat).upper()
        if 'VAD' in cat_upper or 'ADS' in cat_upper or 'AD' in cat_upper:
            kind = 'AD'
        elif 'SESSION' in cat_upper:
            kind = 'CONTENT'
        else:
            kind = 'CONTENT'

    details = e.get('details', {})
    if isinstance(details, dict) and 'details' in details and isinstance(details['details'], dict):
        inner_det = details.get('details', {})
        details = {**details, **inner_det}

    return {
        'rel': rel,
        'timeMs': rel,
        'wall': wall,
        'timestampMs': wall,
        'cat': cat,
        'category': cat,
        'event': event,
        'details': details,
        'kind': kind,
    }


def detect_and_normalise(raw):
    """
    Convenience wrapper: detect schema and normalise in one call.
    """
    return normalise_session(raw)


def get_session_id(normalised):
    """Extract session ID from normalised session."""
    return normalised.get('session', {}).get('id', 'unknown')


def get_event_count(normalised):
    """Get event count from normalised session."""
    return len(normalised.get('events', []))
