"""Header passthrough, redaction default and document validation for schema v3 (plan 1.18, 1.19)."""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from bridge.schema import normalise_session, validate_session_document  # noqa: E402


def _doc(**session_extra):
    session = {"sessionId": "s1", "packageName": "com.example", "redacted": True}
    session.update(session_extra)
    return {"schemaVersion": 3, "session": session,
            "events": [{"tMs": 0, "category": "PLAYBACK", "event": "StateChanged", "details": {}}]}


class HeaderPassthroughTest(unittest.TestCase):

    def test_viewer_counters_survive_normalisation(self):
        raw = _doc(droppedEvents=3, fileErrors=1, recovered=True, attributes={"app": "demo"},
                   device={"manufacturer": "Google"}, media3Version="1.11.0",
                   droppedByCategory={"CHUNK": 2}, health={"swallowed": 0})
        s = normalise_session(raw)["session"]
        self.assertEqual(s["droppedEvents"], 3)
        self.assertEqual(s["fileErrors"], 1)
        self.assertTrue(s["recovered"])
        self.assertEqual(s["attributes"], {"app": "demo"})
        self.assertEqual(s["device"], {"manufacturer": "Google"})
        self.assertEqual(s["media3Version"], "1.11.0")
        self.assertEqual(s["droppedByCategory"], {"CHUNK": 2})
        self.assertEqual(s["health"], {"swallowed": 0})

    def test_missing_redacted_flag_is_treated_as_redacted(self):
        raw = _doc()
        del raw["session"]["redacted"]
        self.assertTrue(normalise_session(raw)["session"]["redacted"])


class ValidateDocumentTest(unittest.TestCase):

    def test_valid_document_passes(self):
        self.assertEqual(validate_session_document(_doc()), (True, None))

    def test_accepts_id_instead_of_sessionId(self):
        raw = _doc()
        raw["session"] = {"id": "abc"}
        self.assertTrue(validate_session_document(raw)[0])

    def test_rejects_non_object_and_missing_header(self):
        self.assertFalse(validate_session_document([])[0])
        self.assertFalse(validate_session_document({"events": []})[0])

    def test_rejects_missing_session_id(self):
        raw = _doc()
        raw["session"] = {"packageName": "x"}
        ok, err = validate_session_document(raw)
        self.assertFalse(ok)
        self.assertIn("session id", err)

    def test_rejects_bad_event_fields(self):
        for bad in ({"tMs": "1", "category": "A", "event": "B"},
                    {"tMs": True, "category": "A", "event": "B"},
                    {"tMs": 1, "category": 5, "event": "B"},
                    {"category": "A", "event": "B"}):
            raw = _doc()
            raw["events"] = [bad]
            self.assertFalse(validate_session_document(raw)[0], bad)

    def test_rejects_events_that_are_not_a_list(self):
        raw = _doc()
        raw["events"] = {"tMs": 1}
        self.assertFalse(validate_session_document(raw)[0])


if __name__ == "__main__":
    unittest.main()
