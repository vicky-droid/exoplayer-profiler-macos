import unittest
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge.schema import (
    detect_schema,
    normalise_session,
    normalise_event,
    detect_and_normalise,
    get_session_id,
    get_event_count,
)


class TestSchemaDetection(unittest.TestCase):

    def test_detect_v3(self):
        raw = {"schemaVersion": 3, "session": {}, "events": []}
        self.assertEqual(detect_schema(raw), "v3")

    def test_detect_v2(self):
        raw = {"session": {}, "events": [{"timeMs": 100}]}
        self.assertEqual(detect_schema(raw), "v2")

    def test_detect_rich(self):
        raw = {"schemaVersion": 1, "session": {}, "events": [], "aggregates": {}, "hash": "abc"}
        self.assertEqual(detect_schema(raw), "rich")

    def test_detect_logcat_list(self):
        raw = [{"category": "Session", "event": "SessionStarted", "details": {}}]
        self.assertEqual(detect_schema(raw), "logcat")

    def test_detect_logcat_dict(self):
        raw = {"events": [{"category": "Session", "event": "SessionStarted", "details": {}}]}
        self.assertEqual(detect_schema(raw), "logcat")

    def test_detect_unknown(self):
        self.assertEqual(detect_schema(None), "unknown")
        self.assertEqual(detect_schema({}), "unknown")
        self.assertEqual(detect_schema([]), "unknown")

    def test_detect_session_schema_alias(self):
        # detect_schema is the same function; just verify naming consistency
        from bridge.schema import detect_schema as detect_session_schema
        self.assertIs(detect_schema, detect_session_schema)


class TestNormaliseV3(unittest.TestCase):

    def test_normalise_v3_basic(self):
        raw = {
            "schemaVersion": 3,
            "session": {
                "sessionId": "sess-123",
                "packageName": "com.example.app",
                "startedAtEpochMs": 1000000,
                "exportedAtEpochMs": 2000000,
                "eventCount": 2,
                "redacted": True,
            },
            "events": [
                {"tMs": 100, "wallMs": 1001000, "category": "SESSION", "event": "SessionStarted", "contentKind": "UNKNOWN", "details": {"device": "test"}},
            ],
        }
        result = normalise_session(raw)

        self.assertEqual(result["schema"], "v3")
        self.assertEqual(result["session"]["id"], "sess-123")
        self.assertEqual(result["session"]["packageName"], "com.example.app")
        self.assertEqual(len(result["events"]), 1)
        self.assertEqual(result["events"][0]["cat"], "SESSION")
        self.assertEqual(result["events"][0]["event"], "SessionStarted")
        self.assertEqual(result["events"][0]["rel"], 100)
        self.assertEqual(result["events"][0]["wall"], 1001000)


class TestNormaliseV2(unittest.TestCase):

    def test_normalise_v2_basic(self):
        raw = {
            "session": {"id": "sess-2", "packageName": "com.example.app"},
            "events": [
                {"timeMs": 50, "timestampMs": 1000050, "category": "SESSION", "event": "SessionStarted", "details": {}}
            ],
        }
        result = normalise_session(raw)

        self.assertEqual(result["schema"], "v2")
        self.assertEqual(result["session"]["id"], "sess-2")
        self.assertEqual(len(result["events"]), 1)
        self.assertEqual(result["events"][0]["rel"], 50)
        self.assertEqual(result["events"][0]["wall"], 1000050)


class TestNormaliseRich(unittest.TestCase):

    def test_normalise_rich(self):
        raw = {
            "session": {"id": "sess-3", "packageName": "com.example.app"},
            "events": [
                {"tMs": 200, "wallMs": 1000200, "category": "VST", "event": "total", "details": {"vstMs": 500}},
            ],
            "aggregates": {},
            "hash": "abc123",
        }
        result = normalise_session(raw)

        self.assertEqual(result["schema"], "rich")
        self.assertEqual(result["session"]["id"], "sess-3")
        self.assertEqual(len(result["events"]), 1)
        self.assertEqual(result["events"][0]["cat"], "VST")


class TestNormaliseLogcat(unittest.TestCase):

    def test_normalise_logcat_list(self):
        raw = [
            {"category": "Session", "event": "SessionStarted", "details": {"device": "test"}},
            {"category": "VST", "event": "total", "details": {"vstMs": 300}},
        ]
        result = normalise_session(raw)

        self.assertEqual(result["schema"], "logcat")
        self.assertEqual(len(result["events"]), 2)
        self.assertEqual(result["events"][0]["cat"], "Session")
        self.assertEqual(result["events"][0]["event"], "SessionStarted")


class TestNormaliseEvent(unittest.TestCase):

    def test_normalise_event_with_tMs(self):
        ev = {"tMs": 500, "wallMs": 1000500, "category": "VST", "event": "total", "details": {"vstMs": 300}}
        result = normalise_event(ev)
        self.assertEqual(result["rel"], 500)
        self.assertEqual(result["wall"], 1000500)
        self.assertEqual(result["cat"], "VST")
        self.assertEqual(result["event"], "total")

    def test_normalise_event_with_timeMs(self):
        ev = {"timeMs": 300, "timestampMs": 1000300, "category": "SESSION", "event": "SessionStarted", "details": {}}
        result = normalise_event(ev)
        self.assertEqual(result["rel"], 300)
        self.assertEqual(result["wall"], 1000300)
        self.assertEqual(result["cat"], "SESSION")
        self.assertEqual(result["event"], "SessionStarted")

    def test_normalise_event_none(self):
        result = normalise_event(None)
        self.assertEqual(result["cat"], "unknown")
        self.assertEqual(result["event"], "None")
        self.assertEqual(result["kind"], "UNKNOWN")

    def test_normalise_event_kind_inference(self):
        ev = {"category": "ADS", "event": "AdBreakStarted", "details": {}}
        result = normalise_event(ev)
        self.assertEqual(result["kind"], "AD")

        ev = {"category": "SESSION", "event": "SessionStarted", "details": {}}
        result = normalise_event(ev)
        self.assertEqual(result["kind"], "CONTENT")

        ev = {"category": "NETWORK", "event": "LoadStarted", "details": {}}
        result = normalise_event(ev)
        self.assertEqual(result["kind"], "CONTENT")  # unknown category defaults to CONTENT


class TestGetSessionId(unittest.TestCase):

    def test_get_session_id(self):
        raw = {"session": {"id": "abc-123"}, "events": []}
        result = normalise_session(raw)
        self.assertEqual(get_session_id(result), "abc-123")

    def test_get_session_id_missing(self):
        raw = {"events": []}
        result = normalise_session(raw)
        self.assertEqual(get_session_id(result), "unknown")


class TestGetEventCount(unittest.TestCase):

    def test_get_event_count(self):
        raw = {"session": {}, "events": [{"tMs": 1}, {"tMs": 2}, {"tMs": 3}]}
        result = normalise_session(raw)
        self.assertEqual(get_event_count(result), 3)

    def test_get_event_count_empty(self):
        raw = {"session": {}, "events": []}
        result = normalise_session(raw)
        self.assertEqual(get_event_count(result), 0)


if __name__ == "__main__":
    unittest.main()