"""End-to-end tests for the ingest endpoints, run against a real HTTP server on an ephemeral port."""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import HTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import bridge.bridge as bridge_mod  # noqa: E402
from bridge.bridge import UploadHandler  # noqa: E402


class _StubLiveSessions:
    def create_session(self, sess_id, schema_version, redacted, device, config):
        return {"id": sess_id}, None


class _StubBridge:
    allow_lan = False

    def __init__(self):
        self.live_sessions = _StubLiveSessions()
        self.scans = 0

    def scan_uploaded_files(self):
        self.scans += 1


class IngestEndpointTest(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_upload_dir = bridge_mod.UPLOAD_DIR
        bridge_mod.UPLOAD_DIR = self._tmp.name
        self._orig_token = os.environ.pop("EXOPROFILER_UPLOAD_TOKEN", None)
        self.bridge = _StubBridge()
        self.server = HTTPServer(("127.0.0.1", 0), UploadHandler)
        self.server.bridge = self.bridge
        self.port = self.server.server_address[1]
        self._thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self._thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        bridge_mod.UPLOAD_DIR = self._orig_upload_dir
        if self._orig_token is not None:
            os.environ["EXOPROFILER_UPLOAD_TOKEN"] = self._orig_token
        else:
            os.environ.pop("EXOPROFILER_UPLOAD_TOKEN", None)
        self._tmp.cleanup()

    def _post(self, path, body, headers=None):
        raw = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}", data=raw, method="POST",
            headers={"Content-Type": "application/json", **(headers or {})},
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def _session(self, sid="abc123"):
        return {"session": {"id": sid, "packageName": "com.example"}, "events": [
            {"tMs": 1, "category": "PLAYBACK", "event": "StateChanged", "data": {}}]}

    # --- acceptance ---------------------------------------------------------

    def test_accepts_session_with_id_and_writes_file(self):
        status, body = self._post("/upload", self._session("sess_1"))
        self.assertEqual(status, 200)
        self.assertEqual(body["filename"], "sess_1.json")
        self.assertTrue(os.path.exists(os.path.join(self._tmp.name, "sess_1.json")))
        self.assertEqual(self.bridge.scans, 1)

    def test_accepts_session_with_events_only_and_uses_unique_name(self):
        payload = {"events": [{"tMs": 1, "category": "PLAYBACK", "event": "Loaded"}]}
        status1, body1 = self._post("/upload", payload)
        status2, body2 = self._post("/upload", payload)
        self.assertEqual((status1, status2), (200, 200))
        self.assertNotEqual(body1["filename"], body2["filename"])
        self.assertEqual(len(os.listdir(self._tmp.name)), 2)

    def test_save_session_alias_uses_same_validation(self):
        status, _ = self._post("/save-session", self._session("sess_2"))
        self.assertEqual(status, 200)

    # --- validation ---------------------------------------------------------

    def test_rejects_arbitrary_json_object(self):
        status, body = self._post("/upload", {"x": 1})
        self.assertEqual(status, 400)
        self.assertIn("Not a profiler session", body["message"])
        self.assertEqual(os.listdir(self._tmp.name), [])

    def test_rejects_invalid_json(self):
        status, body = self._post("/upload", b"not json")
        self.assertEqual(status, 400)
        self.assertEqual(body["message"], "Invalid JSON")

    def test_rejects_json_array(self):
        status, _ = self._post("/upload", [1, 2, 3])
        self.assertEqual(status, 400)

    def test_rejects_oversized_payload_without_reading_it(self):
        bridge_mod.MAX_UPLOAD_BYTES = 10
        try:
            status, body = self._post("/upload", self._session())
        finally:
            bridge_mod.MAX_UPLOAD_BYTES = 50 * 1024 * 1024
        self.assertEqual(status, 413)
        self.assertEqual(os.listdir(self._tmp.name), [])

    def test_session_id_is_sanitised_against_path_traversal(self):
        status, body = self._post("/upload", self._session("../../evil"))
        self.assertEqual(status, 200)
        self.assertNotIn("/", body["filename"])
        self.assertTrue(os.path.exists(os.path.join(self._tmp.name, body["filename"])))

    # --- optional token auth ------------------------------------------------

    def test_open_when_no_token_configured(self):
        status, _ = self._post("/upload", self._session("open_1"))
        self.assertEqual(status, 200)

    def test_token_required_when_configured(self):
        os.environ["EXOPROFILER_UPLOAD_TOKEN"] = "s3cret"
        status, body = self._post("/upload", self._session("auth_1"))
        self.assertEqual(status, 401)
        self.assertEqual(body["message"], "Unauthorized")
        self.assertEqual(os.listdir(self._tmp.name), [])

    def test_wrong_token_rejected(self):
        os.environ["EXOPROFILER_UPLOAD_TOKEN"] = "s3cret"
        status, _ = self._post("/upload", self._session("auth_2"),
                               headers={"Authorization": "Bearer nope"})
        self.assertEqual(status, 401)

    def test_bearer_token_accepted(self):
        os.environ["EXOPROFILER_UPLOAD_TOKEN"] = "s3cret"
        status, _ = self._post("/upload", self._session("auth_3"),
                               headers={"Authorization": "Bearer s3cret"})
        self.assertEqual(status, 200)

    def test_token_also_guards_v3_sessions_endpoint(self):
        os.environ["EXOPROFILER_UPLOAD_TOKEN"] = "s3cret"
        status, _ = self._post("/api/v3/sessions", self._session("v3_1"))
        self.assertEqual(status, 401)
        status, _ = self._post("/api/v3/sessions", self._session("v3_1"),
                               headers={"Authorization": "Bearer s3cret"})
        self.assertEqual(status, 201)

    # --- 1.17: the v3 endpoint must persist what it accepts -------------------

    def _v3_doc(self, sid="v3_store"):
        return {
            "schemaVersion": 3,
            "session": {"sessionId": sid, "packageName": "com.example", "eventCount": 2, "redacted": True,
                        "droppedEvents": 4, "recovered": True, "device": {"manufacturer": "Google"}},
            "events": [
                {"tMs": 1, "category": "PLAYBACK", "event": "StateChanged", "details": {}},
                {"tMs": 9, "category": "VIDEO", "event": "RenderedFirstFrame", "details": {}},
            ],
        }

    def test_v3_endpoint_writes_file_with_header_counters(self):
        status, body = self._post("/api/v3/sessions", self._v3_doc("v3_store"))
        self.assertEqual(status, 201)
        self.assertEqual(body["filename"], "v3_store.json")
        with open(os.path.join(self._tmp.name, "v3_store.json")) as f:
            stored = json.load(f)
        self.assertEqual(len(stored["events"]), 2)
        self.assertEqual(stored["session"]["droppedEvents"], 4)
        self.assertTrue(stored["session"]["recovered"])
        self.assertEqual(stored["session"]["operationCount"], len(stored["operations"]))
        self.assertEqual(self.bridge.scans, 1)

    def test_v3_endpoint_rejects_bad_shape_and_writes_nothing(self):
        bad = self._v3_doc("v3_bad")
        bad["events"][0]["tMs"] = "soon"
        status, body = self._post("/api/v3/sessions", bad)
        self.assertEqual(status, 400)
        self.assertIn("tMs", body["message"])
        self.assertEqual(os.listdir(self._tmp.name), [])

    def test_v3_endpoint_reports_500_when_write_fails(self):
        from unittest import mock
        with mock.patch("bridge.bridge.os.replace", side_effect=OSError("disk full")):
            status, body = self._post("/api/v3/sessions", self._v3_doc("v3_full"))
        self.assertEqual(status, 500)
        self.assertNotIn("v3_full.json", os.listdir(self._tmp.name))
        self.assertEqual(self.bridge.scans, 0)


class StartupTest(unittest.TestCase):

    def test_script_runs_directly_as_documented(self):
        """`python3 bridge/bridge.py` must import cleanly (the README's documented command)."""
        script = os.path.join(ROOT, "bridge", "bridge.py")
        probe = (
            "import runpy;"
            "ns = runpy.run_path(%r, run_name='not_main');"
            "print('IMPORTED', callable(ns['ExoBridge']))" % script
        )
        with tempfile.TemporaryDirectory() as tmp:
            env = {**os.environ, "EXOPROFILER_UPLOAD_DIR": tmp}
            # cwd is outside the project, so only the script's own path setup can make `bridge` importable.
            result = subprocess.run([sys.executable, "-c", probe], cwd=tmp, env=env,
                                    capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("IMPORTED True", result.stdout)


if __name__ == "__main__":
    unittest.main()
