"""Content vs ad formats and rule evaluation (plan V8). Pure functions, no I/O.

Rules are plain JSON so the SDK team can reuse them. Each rule result is
deterministic for a given session: ``pass``, ``fail`` or ``n/a``.
"""

import json

DEFAULT_RULES = [
    {"id": "max_chunk_gap", "type": "max_chunk_gap_ms", "threshold": 2000,
     "label": "Chunk gap at most 2 s"},
    {"id": "max_startup", "type": "max_startup_ms", "threshold": 3000,
     "label": "Startup (VST) at most 3 s"},
    {"id": "max_dropped_frames", "type": "max_dropped_frames", "threshold": 30,
     "label": "Dropped frames at most 30"},
    {"id": "no_errors", "type": "max_error_count", "threshold": 0,
     "label": "No player errors"},
    {"id": "ad_format_match", "type": "ad_format_match", "threshold": None,
     "label": "Ad format matches content"},
]

KNOWN_RULE_TYPES = {
    "max_chunk_gap_ms", "max_startup_ms", "max_dropped_frames", "max_error_count",
    "ad_format_match",
}

FORMAT_FIELDS = ("codecs", "sampleMime", "bitrate", "frameRate", "channels", "sampleRate")
COLOR_FIELDS = ("hdrType", "space", "transfer")


def format_delta(content, ad):
    """Compare two format dicts (from InputFormat event details). Returns a list of deltas."""
    content = content or {}
    ad = ad or {}
    deltas = []

    def add(field, a, b):
        deltas.append({"field": field, "content": a, "ad": b, "mismatch": a != b})

    for field in FORMAT_FIELDS:
        add(field, _text(content.get(field)), _text(ad.get(field)))
    add("resolution", f"{content.get('width')}x{content.get('height')}",
        f"{ad.get('width')}x{ad.get('height')}")
    color_a = content.get("color") or {}
    color_b = ad.get("color") or {}
    for field in COLOR_FIELDS:
        add("color." + field, _text(color_a.get(field)), _text(color_b.get(field)))
    return deltas


def format_verdict(deltas):
    return "mismatch" if any(d["mismatch"] for d in deltas) else "same format"


def _text(value):
    return None if value is None else str(value)


def _events_of(events, category, name, kind=None):
    for e in events:
        if e.get("cat") == category and e.get("event") == name:
            if kind is None or e.get("kind") == kind:
                yield e


def _latest_format(events, category, kind):
    found = None
    for e in _events_of(events, category, "InputFormat", kind):
        found = e.get("details") or {}
    return found


def formats_view(events):
    """Content vs ad video format for the Formats tab, or None when no ad format was seen."""
    content = _latest_format(events, "VIDEO", "CONTENT")
    ad = _latest_format(events, "VIDEO", "AD")
    if content is None or ad is None:
        return None
    deltas = format_delta(content, ad)
    return {"verdict": format_verdict(deltas), "deltas": deltas}


def validate_rules(rules):
    """Returns a list of problems. An empty list means the rules can be evaluated."""
    problems = []
    if not isinstance(rules, list):
        return ["rules must be a list"]
    seen = set()
    for index, rule in enumerate(rules):
        if not isinstance(rule, dict):
            problems.append(f"rule {index} is not an object")
            continue
        rule_id = rule.get("id")
        if not rule_id or not isinstance(rule_id, str):
            problems.append(f"rule {index} has no id")
        elif rule_id in seen:
            problems.append(f"duplicate rule id {rule_id}")
        else:
            seen.add(rule_id)
        if rule.get("type") not in KNOWN_RULE_TYPES:
            problems.append(f"rule {rule_id or index} has an unknown type")
        if rule.get("type") != "ad_format_match":
            threshold = rule.get("threshold")
            if not isinstance(threshold, (int, float)) or isinstance(threshold, bool):
                problems.append(f"rule {rule_id or index} needs a numeric threshold")
    return problems


def load_rules(text):
    """Parse a rules JSON document. Raises ValueError with a readable message."""
    try:
        rules = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(f"rules JSON is invalid: {e.msg}")
    problems = validate_rules(rules)
    if problems:
        raise ValueError("; ".join(problems))
    return rules


def evaluate_rules(rules, events, chunk_rows):
    """Evaluate ``rules`` against normalised events and chunk rows. Returns one result per rule."""
    results = []
    for rule in rules:
        rule_type = rule.get("type")
        threshold = rule.get("threshold")
        base = {"id": rule.get("id"), "label": rule.get("label", rule.get("id")), "type": rule_type,
                "threshold": threshold}
        if rule_type == "max_chunk_gap_ms":
            gaps = [(r["gapBeforeMs"] or 0, r["requestStartMs"]) for r in chunk_rows]
            worst = max(gaps, default=(0, 0))
            value = worst[0]
            results.append(_result(base, value, value <= threshold,
                                   f"largest gap {value} ms", marker_ms=worst[1]))
        elif rule_type == "max_startup_ms":
            vst = None
            for e in _events_of(events, "VST", "total"):
                vst = (e.get("details") or {}).get("vstMs", vst)
            if vst is None:
                results.append(_result(base, None, None, "no startup measurement in this session"))
            else:
                results.append(_result(base, vst, vst <= threshold, f"startup {vst} ms"))
        elif rule_type == "max_dropped_frames":
            total = 0
            for e in _events_of(events, "VIDEO", "DroppedFrames"):
                total += int((e.get("details") or {}).get("droppedFrames", 0) or 0)
            results.append(_result(base, total, total <= threshold, f"{total} dropped frames"))
        elif rule_type == "max_error_count":
            errors = [e for e in events if e.get("cat") == "ERROR"]
            count = len(errors)
            marker = errors[0]["rel"] if errors else None
            results.append(_result(base, count, count <= threshold, f"{count} error events",
                                   marker_ms=marker))
        elif rule_type == "ad_format_match":
            view = formats_view(events)
            if view is None:
                results.append(_result(base, None, None, "no ad format in this session"))
            else:
                ok = view["verdict"] == "same format"
                results.append(_result(base, view["verdict"], ok,
                                       "ad and content formats " + ("match" if ok else "differ")))
        else:
            results.append(_result(base, None, None, f"unknown rule type {rule_type}"))
    return results


def _result(base, value, ok, message, marker_ms=None):
    status = "n/a" if ok is None else ("pass" if ok else "fail")
    out = dict(base)
    out.update({"status": status, "value": value, "message": message})
    if marker_ms is not None:
        out["markerMs"] = marker_ms
    return out
