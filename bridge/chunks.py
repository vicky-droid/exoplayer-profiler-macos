"""Chunk table data (plan V6): extraction, filters, derived rows and CSV export.

Input is the normalised event list from ``schema.normalise_session`` (each event has
``rel``, ``cat``, ``event``, ``details``, ``kind``). Pure functions, no I/O.
"""

import csv
import io

COLUMNS = (
    "chunkId", "dataType", "trackType", "trackFormatId", "uriRedacted",
    "byteStart", "byteLength", "mediaStartMs", "mediaEndMs", "durationMs",
    "requestStartMs", "loadDurationMs", "bytesLoaded", "throughputKbps",
    "cacheHint", "outcome", "gapBeforeMs", "kind",
)

# Full uriRaw never goes into rows; the ffprobe endpoint reads it from the session itself.
_SLOW_THROUGHPUT_KBPS = 1000


def extract_rows(events):
    """One row per chunk, from CHUNK/Loaded events (the SDK's ChunkLoaded records).

    Rows are sorted by chunk id. When the same chunk id appears more than once the
    last record wins. Legacy sessions without chunk records return no rows (best
    effort derivation from LoadStarted/LoadCompleted is documented as a limit).
    """
    by_id = {}
    for event in events:
        if event.get("cat") != "CHUNK":
            continue
        details = event.get("details") or {}
        chunk_id = details.get("chunkId")
        if chunk_id is None:
            continue
        row = {
            "chunkId": int(chunk_id),
            "dataType": details.get("dataType", "OTHER"),
            "trackType": details.get("trackType", "UNKNOWN"),
            "trackFormatId": details.get("trackFormatId"),
            "uriRedacted": details.get("uriRedacted", ""),
            "byteStart": details.get("byteStart", 0),
            "byteLength": details.get("byteLength", -1),
            "mediaStartMs": details.get("mediaStartMs", -1),
            "mediaEndMs": details.get("mediaEndMs", -1),
            "durationMs": details.get("durationMs", -1),
            "requestStartMs": details.get("requestStartMs", event.get("rel", 0)),
            "loadDurationMs": details.get("loadDurationMs", 0),
            "bytesLoaded": details.get("bytesLoaded", 0),
            "throughputKbps": details.get("throughputKbps", 0),
            "cacheHint": details.get("cacheHint"),
            "outcome": details.get("outcome", "COMPLETED"),
            "gapBeforeMs": details.get("gapBeforeMs"),
            "kind": event.get("kind", "UNKNOWN"),
        }
        by_id[row["chunkId"]] = row
    return [by_id[k] for k in sorted(by_id)]


def filter_rows(rows, track_type=None, outcome=None, errors_only=False, gaps_only=False,
                slow_only=False, kind=None, text=None):
    """Apply the table filters. Every argument is optional; None means no filter."""
    text_lower = text.lower() if text else None
    result = []
    for row in rows:
        if track_type and row["trackType"] != track_type:
            continue
        if outcome and row["outcome"] != outcome:
            continue
        if errors_only and row["outcome"] == "COMPLETED":
            continue
        if gaps_only and not (row["gapBeforeMs"] or 0) > 0:
            continue
        if slow_only and row["throughputKbps"] >= _SLOW_THROUGHPUT_KBPS:
            continue
        if kind and row["kind"] != kind:
            continue
        if text_lower and text_lower not in (row["uriRedacted"] or "").lower() \
                and text_lower not in str(row["dataType"]).lower():
            continue
        result.append(row)
    return result


def summary(rows):
    """Footer counts: totals, average throughput and gap count."""
    if not rows:
        return {"count": 0, "totalBytes": 0, "avgThroughputKbps": 0, "gapCount": 0, "errorCount": 0}
    total_bytes = sum(int(r["bytesLoaded"] or 0) for r in rows)
    throughputs = [r["throughputKbps"] for r in rows if r["throughputKbps"]]
    return {
        "count": len(rows),
        "totalBytes": total_bytes,
        "avgThroughputKbps": int(sum(throughputs) / len(throughputs)) if throughputs else 0,
        "gapCount": sum(1 for r in rows if (r["gapBeforeMs"] or 0) > 0),
        "errorCount": sum(1 for r in rows if r["outcome"] != "COMPLETED"),
    }


def to_csv(rows, columns=COLUMNS):
    """CSV of the visible rows. Only the given columns are written, in order."""
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=list(columns), extrasaction="ignore")
    writer.writeheader()
    for row in rows:
        writer.writerow(row)
    return buf.getvalue()
