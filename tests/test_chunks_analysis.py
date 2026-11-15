"""Tests for the chunk table data (V6), formats diff and rules (V8), and the LAN policy (V2)."""

import csv
import io
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from bridge import analysis, chunks  # noqa: E402
from bridge.bridge import find_session_events, resolve_lan_policy  # noqa: E402
from bridge.schema import normalise_event  # noqa: E402


def _chunk(cid, outcome="COMPLETED", gap=None, kbps=2000, data_type="MEDIA", track="VIDEO", raw=None):
    details = {
        "chunkId": cid, "dataType": data_type, "trackType": track, "trackFormatId": "5",
        "uriRedacted": f"https://cdn.example.com/<id>/seg{cid}.m4s", "byteStart": 0,
        "byteLength": -1, "mediaStartMs": cid * 2000, "mediaEndMs": cid * 2000 + 2000,
        "durationMs": 2000, "requestStartMs": 100 * cid, "loadDurationMs": 50,
        "bytesLoaded": 1000 * cid, "throughputKbps": kbps, "cacheHint": "HIT",
        "outcome": outcome, "gapBeforeMs": gap,
    }
    if raw is not None:
        details["uriRaw"] = raw
    return {"rel": 100 * cid, "cat": "CHUNK", "event": "Loaded", "details": details, "kind": "CONTENT"}


class ChunkRowsTest(unittest.TestCase):
    def setUp(self):
        self.events = [
            _chunk(2, gap=300),
            _chunk(1),
            _chunk(3, outcome="ERROR", kbps=400, track="AUDIO"),
            {"rel": 1, "cat": "CHUNK", "event": "LoadStarted", "details": {"uriRedacted": "x"}, "kind": "CONTENT"},
        ]

    def test_rows_sorted_by_chunk_id_and_skip_records_without_id(self):
        rows = chunks.extract_rows(self.events)
        self.assertEqual([r["chunkId"] for r in rows], [1, 2, 3])

    def test_rows_never_carry_the_raw_uri(self):
        events = [_chunk(1, raw="https://cdn.example.com/a/seg.m4s?token=SECRET")]
        rows = chunks.extract_rows(events)
        self.assertNotIn("uriRaw", rows[0])
        self.assertNotIn("SECRET", json.dumps(rows))

    def test_filters(self):
        rows = chunks.extract_rows(self.events)
        self.assertEqual([r["chunkId"] for r in chunks.filter_rows(rows, errors_only=True)], [3])
        self.assertEqual([r["chunkId"] for r in chunks.filter_rows(rows, gaps_only=True)], [2])
        self.assertEqual([r["chunkId"] for r in chunks.filter_rows(rows, slow_only=True)], [3])
        self.assertEqual([r["chunkId"] for r in chunks.filter_rows(rows, track_type="AUDIO")], [3])
        self.assertEqual([r["chunkId"] for r in chunks.filter_rows(rows, text="seg2")], [2])

    def test_summary_footer(self):
        rows = chunks.extract_rows(self.events)
        s = chunks.summary(rows)
        self.assertEqual(s["count"], 3)
        self.assertEqual(s["gapCount"], 1)
        self.assertEqual(s["errorCount"], 1)
        self.assertEqual(s["totalBytes"], 1000 + 2000 + 3000)

    def test_csv_matches_visible_rows_only(self):
        rows = chunks.filter_rows(chunks.extract_rows(self.events), errors_only=True)
        parsed = list(csv.DictReader(io.StringIO(chunks.to_csv(rows))))
        self.assertEqual(len(parsed), 1)
        self.assertEqual(parsed[0]["chunkId"], "3")
        self.assertEqual(list(parsed[0].keys()), list(chunks.COLUMNS))


class FormatsTest(unittest.TestCase):
    def _format_event(self, kind, codecs="avc1.4D401F", width=960, height=540, hdr="SDR"):
        return {"cat": "VIDEO", "event": "InputFormat", "kind": kind, "details": {
            "sampleMime": "video/avc", "codecs": codecs, "bitrate": 2000000, "width": width,
            "height": height, "frameRate": 30.0, "channels": 0, "sampleRate": 0,
            "color": {"space": "BT709", "transfer": "SDR", "hdrType": hdr}}}

    def test_same_format_verdict(self):
        view = analysis.formats_view([self._format_event("CONTENT"), self._format_event("AD")])
        self.assertEqual(view["verdict"], "same format")

    def test_mismatch_lists_differing_fields(self):
        view = analysis.formats_view([
            self._format_event("CONTENT"),
            self._format_event("AD", codecs="avc1.64001F", width=640, height=360, hdr="HDR10"),
        ])
        self.assertEqual(view["verdict"], "mismatch")
        differing = {d["field"] for d in view["deltas"] if d["mismatch"]}
        self.assertEqual(differing, {"codecs", "resolution", "color.hdrType"})

    def test_no_ad_format_gives_none(self):
        self.assertIsNone(analysis.formats_view([self._format_event("CONTENT")]))


class RulesTest(unittest.TestCase):
    def test_default_rules_are_valid(self):
        self.assertEqual(analysis.validate_rules(analysis.DEFAULT_RULES), [])

    def test_rule_results_are_deterministic_and_correct(self):
        events = [
            {"rel": 10, "cat": "VST", "event": "total", "details": {"vstMs": 1500}, "kind": "CONTENT"},
            {"rel": 20, "cat": "ERROR", "event": "PlayerError", "details": {}, "kind": "CONTENT"},
        ]
        rows = chunks.extract_rows([_chunk(1, gap=5000)])
        results = {r["id"]: r for r in analysis.evaluate_rules(analysis.DEFAULT_RULES, events, rows)}
        self.assertEqual(results["max_chunk_gap"]["status"], "fail")
        self.assertEqual(results["max_chunk_gap"]["markerMs"], 100)
        self.assertEqual(results["max_startup"]["status"], "pass")
        self.assertEqual(results["no_errors"]["status"], "fail")
        self.assertEqual(results["ad_format_match"]["status"], "n/a")
        again = {r["id"]: r for r in analysis.evaluate_rules(analysis.DEFAULT_RULES, events, rows)}
        self.assertEqual(results, again)

    def test_missing_measurement_is_not_a_pass(self):
        results = analysis.evaluate_rules(
            [{"id": "s", "type": "max_startup_ms", "threshold": 1000}], [], [])
        self.assertEqual(results[0]["status"], "n/a")

    def test_invalid_rules_are_rejected_with_reasons(self):
        problems = analysis.validate_rules([{"id": "a", "type": "nope"},
                                            {"id": "a", "type": "max_startup_ms", "threshold": "x"}])
        self.assertTrue(any("unknown type" in p for p in problems))
        self.assertTrue(any("duplicate" in p for p in problems))
        self.assertTrue(any("numeric threshold" in p for p in problems))

    def test_load_rules_round_trip(self):
        text = json.dumps([{"id": "g", "type": "max_chunk_gap_ms", "threshold": 1000}])
        self.assertEqual(analysis.load_rules(text)[0]["id"], "g")
        with self.assertRaises(ValueError):
            analysis.load_rules("{not json")


class LanPolicyTest(unittest.TestCase):
    def test_lan_without_both_tokens_stays_local(self):
        allowed, warning = resolve_lan_policy(True, {"EXOPROFILER_UPLOAD_TOKEN": "x"})
        self.assertFalse(allowed)
        self.assertIn("both", warning)

    def test_lan_with_both_tokens_is_allowed(self):
        allowed, warning = resolve_lan_policy(
            True, {"EXOPROFILER_UPLOAD_TOKEN": "x", "EXOPROFILER_LIVE_TOKEN": "y"})
        self.assertTrue(allowed)
        self.assertIsNone(warning)

    def test_local_mode_never_warns(self):
        self.assertEqual(resolve_lan_policy(False, {}), (False, None))


class SessionLookupTest(unittest.TestCase):
    class _Live:
        def __init__(self):
            self.events = [{"tMs": 1, "category": "CHUNK", "event": "Loaded", "details": {"chunkId": 1}}]
            self.redacted = False

    class _Manager:
        def __init__(self, live):
            self._live = live

        def get_session(self, sid):
            return self._live if sid == "live-1" else None

    class _Bridge:
        def __init__(self, live):
            self.live_sessions = SessionLookupTest._Manager(live)

    def test_live_session_events_are_normalised(self):
        events, redacted, found = find_session_events(self._Bridge(self._Live()), "live-1")
        self.assertTrue(found)
        self.assertFalse(redacted)
        self.assertEqual(events[0]["cat"], "CHUNK")

    def test_unknown_session_is_not_found(self):
        events, redacted, found = find_session_events(self._Bridge(self._Live()), "missing")
        self.assertFalse(found)
        self.assertEqual(events, [])


if __name__ == "__main__":
    unittest.main()
