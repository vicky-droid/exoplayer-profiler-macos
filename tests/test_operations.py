import unittest
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge.bridge import parse_operations_from_events, extract_correlation_id, ExoBridge


class TestOperationPairing(unittest.TestCase):

    def test_basic_paired_and_standalone_events(self):
        events = [
            {"event": "VideoStartupTime", "timeMs": 10, "timestampMs": 1000, "details": {"startupTimeMs": 200}},
            {"event": "ad_break_start", "timeMs": 100, "timestampMs": 1100, "category": "ad", "details": {"id": "ad1"}},
            {"event": "ad_break_end", "timeMs": 500, "timestampMs": 1500, "category": "ad", "details": {"id": "ad1", "adCount": 2}},
            {"event": "drm_license_start", "timeMs": 600, "timestampMs": 1600, "category": "drm", "details": {"scheme": "widevine"}},
            {"event": "drm_license_end", "timeMs": 850, "timestampMs": 1850, "category": "drm", "details": {"status": "ok"}},
            {"event": "PlayerAttached", "timeMs": 900, "timestampMs": 1900, "details": {}},
        ]

        ops = parse_operations_from_events(events)
        self.assertEqual(len(ops), 2)

        # First operation: ad_break
        ad_op = ops[0]
        self.assertEqual(ad_op["operation"], "ad_break")
        self.assertEqual(ad_op["status"], "completed")
        self.assertEqual(ad_op["startTimeMs"], 100)
        self.assertEqual(ad_op["endTimeMs"], 500)
        self.assertEqual(ad_op["durationMs"], 400)
        self.assertEqual(ad_op["correlationId"], "ad1")

        # Second operation: drm_license
        drm_op = ops[1]
        self.assertEqual(drm_op["operation"], "drm_license")
        self.assertEqual(drm_op["status"], "completed")
        self.assertEqual(drm_op["startTimeMs"], 600)
        self.assertEqual(drm_op["endTimeMs"], 850)
        self.assertEqual(drm_op["durationMs"], 250)

    def test_custom_event_names_agnostic(self):
        """Verify suffix matching works for arbitrary unknown event names."""
        events = [
            {"event": "content_authorization_start", "timeMs": 200, "details": {"token": "abc"}},
            {"event": "content_authorization_end", "timeMs": 750, "details": {"status": 200}},
            {"event": "custom_fetch_pipeline_start", "timeMs": 800, "details": {}},
            {"event": "custom_fetch_pipeline_end", "timeMs": 1200, "details": {}},
        ]

        ops = parse_operations_from_events(events)
        self.assertEqual(len(ops), 2)
        self.assertEqual(ops[0]["operation"], "content_authorization")
        self.assertEqual(ops[0]["durationMs"], 550)

        self.assertEqual(ops[1]["operation"], "custom_fetch_pipeline")
        self.assertEqual(ops[1]["durationMs"], 400)

    def test_incomplete_and_unmatched_operations(self):
        """Test active/incomplete starts and unmatched ends."""
        events = [
            # Unmatched end
            {"event": "authorization_end", "timeMs": 300, "details": {}},
            # Incomplete start (no end)
            {"event": "ad_break_start", "timeMs": 500, "details": {"id": "ad99"}},
        ]

        ops = parse_operations_from_events(events)
        self.assertEqual(len(ops), 2)

        unmatched = [o for o in ops if o["status"] == "unmatched_end"][0]
        self.assertEqual(unmatched["operation"], "authorization")
        self.assertEqual(unmatched["endTimeMs"], 300)
        self.assertIsNone(unmatched["startTimeMs"])

        incomplete = [o for o in ops if o["status"] == "incomplete"][0]
        self.assertEqual(incomplete["operation"], "ad_break")
        self.assertEqual(incomplete["startTimeMs"], 500)
        self.assertIsNone(incomplete["endTimeMs"])
        self.assertIsNone(incomplete["durationMs"])

    def test_concurrent_overlapping_operations_with_correlation_ids(self):
        """Test overlapping operations of the same type matched by correlation ID."""
        events = [
            {"event": "ad_break_start", "timeMs": 100, "details": {"id": "break_1"}},
            {"event": "ad_break_start", "timeMs": 200, "details": {"id": "break_2"}},
            # End break_1 first
            {"event": "ad_break_end", "timeMs": 600, "details": {"id": "break_1"}},
            # End break_2
            {"event": "ad_break_end", "timeMs": 800, "details": {"id": "break_2"}},
        ]

        ops = parse_operations_from_events(events)
        self.assertEqual(len(ops), 2)

        op1 = [o for o in ops if o["correlationId"] == "break_1"][0]
        self.assertEqual(op1["startTimeMs"], 100)
        self.assertEqual(op1["endTimeMs"], 600)
        self.assertEqual(op1["durationMs"], 500)

        op2 = [o for o in ops if o["correlationId"] == "break_2"][0]
        self.assertEqual(op2["startTimeMs"], 200)
        self.assertEqual(op2["endTimeMs"], 800)
        self.assertEqual(op2["durationMs"], 600)

    def test_concurrent_overlapping_operations_lifo_fallback(self):
        """Test overlapping operations without correlation IDs falling back to LIFO stack."""
        events = [
            {"event": "nested_op_start", "timeMs": 100, "details": {}},
            {"event": "nested_op_start", "timeMs": 200, "details": {}},
            {"event": "nested_op_end", "timeMs": 300, "details": {}},  # Ends 2nd start (LIFO)
            {"event": "nested_op_end", "timeMs": 500, "details": {}},  # Ends 1st start
        ]

        ops = parse_operations_from_events(events)
        self.assertEqual(len(ops), 2)

        # LIFO: start@200 matched with end@300 -> duration 100
        # LIFO: start@100 matched with end@500 -> duration 400
        durations = [o["durationMs"] for o in ops]
        self.assertIn(100, durations)
        self.assertIn(400, durations)

    def test_clock_normalization(self):
        """Test timestamp fallback and duration non-negativity."""
        events = [
            {"event": "test_op_start", "ts": 100.0, "details": {}},
            {"event": "test_op_end", "ts": 102.5, "details": {}},
        ]
        ops = parse_operations_from_events(events)
        self.assertEqual(len(ops), 1)
        self.assertEqual(ops[0]["durationMs"], 2500)


if __name__ == "__main__":
    unittest.main()
