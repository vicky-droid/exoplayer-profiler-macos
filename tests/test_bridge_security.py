import unittest
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge.bridge import ExoBridge, UploadHandler


class DummyServer:
    def __init__(self, bridge=None):
        self.bridge = bridge


class DummyUploadHandler(UploadHandler):
    """Subclass UploadHandler to test CORS header resolution without starting an HTTP socket."""

    def __init__(self, headers, server):
        self.headers = headers
        self.server = server
        self._sent_headers = {}

    def send_header(self, keyword, value):
        self._sent_headers[keyword] = value

    def send_response(self, code, message=None):
        self._response_code = code

    def end_headers(self):
        pass


class TestBridgeSecurity(unittest.TestCase):

    def setUp(self):
        self._orig_host = os.environ.get("EXOPROFILER_HOST")
        self._orig_lan = os.environ.get("EXOPROFILER_ALLOW_LAN")
        self._orig_tokens = {k: os.environ.get(k) for k in ("EXOPROFILER_UPLOAD_TOKEN", "EXOPROFILER_LIVE_TOKEN")}
        for key in ("EXOPROFILER_HOST", "EXOPROFILER_ALLOW_LAN", "EXOPROFILER_UPLOAD_TOKEN", "EXOPROFILER_LIVE_TOKEN"):
            if key in os.environ:
                del os.environ[key]

    def tearDown(self):
        if self._orig_host is not None:
            os.environ["EXOPROFILER_HOST"] = self._orig_host
        elif "EXOPROFILER_HOST" in os.environ:
            del os.environ["EXOPROFILER_HOST"]

        if self._orig_lan is not None:
            os.environ["EXOPROFILER_ALLOW_LAN"] = self._orig_lan
        elif "EXOPROFILER_ALLOW_LAN" in os.environ:
            del os.environ["EXOPROFILER_ALLOW_LAN"]
        for key, value in self._orig_tokens.items():
            if value is not None:
                os.environ[key] = value
            elif key in os.environ:
                del os.environ[key]

    def _set_both_tokens(self):
        os.environ["EXOPROFILER_UPLOAD_TOKEN"] = "upload-test-token"
        os.environ["EXOPROFILER_LIVE_TOKEN"] = "live-test-token"

    def test_default_binding_is_localhost(self):
        bridge = ExoBridge("PlaybackProfiler", 9090)
        self.assertEqual(bridge.host, "127.0.0.1")
        self.assertFalse(bridge.allow_lan)

    def test_env_override_host(self):
        os.environ["EXOPROFILER_HOST"] = "192.168.1.50"
        bridge = ExoBridge("PlaybackProfiler", 9090)
        self.assertEqual(bridge.host, "192.168.1.50")

    def test_lan_mode_without_tokens_stays_on_localhost(self):
        os.environ["EXOPROFILER_ALLOW_LAN"] = "1"
        bridge = ExoBridge("PlaybackProfiler", 9090)
        self.assertEqual(bridge.host, "127.0.0.1")
        self.assertFalse(bridge.allow_lan)

    def test_lan_mode_binds_all_interfaces(self):
        self._set_both_tokens()
        os.environ["EXOPROFILER_ALLOW_LAN"] = "1"
        bridge = ExoBridge("PlaybackProfiler", 9090)
        self.assertEqual(bridge.host, "0.0.0.0")
        self.assertTrue(bridge.allow_lan)

    def test_cors_localhost_allowed_in_default_mode(self):
        bridge = ExoBridge("PlaybackProfiler", 9090, allow_lan=False)
        server = DummyServer(bridge)

        # Test localhost origin
        handler = DummyUploadHandler({"Origin": "http://localhost:9091"}, server)
        handler._set_cors_headers()
        self.assertEqual(handler._sent_headers.get("Access-Control-Allow-Origin"), "http://localhost:9091")
        self.assertEqual(handler._sent_headers.get("Vary"), "Origin")

        # Test 127.0.0.1 origin
        handler2 = DummyUploadHandler({"Origin": "http://127.0.0.1:3000"}, server)
        handler2._set_cors_headers()
        self.assertEqual(handler2._sent_headers.get("Access-Control-Allow-Origin"), "http://127.0.0.1:3000")

    def test_cors_external_origin_blocked_in_default_mode(self):
        bridge = ExoBridge("PlaybackProfiler", 9090, allow_lan=False)
        server = DummyServer(bridge)

        # External origin should NOT get an Access-Control-Allow-Origin header
        handler = DummyUploadHandler({"Origin": "https://malicious-website.com"}, server)
        handler._set_cors_headers()
        self.assertNotIn("Access-Control-Allow-Origin", handler._sent_headers)

    def test_cors_wildcard_when_lan_allowed(self):
        self._set_both_tokens()
        bridge = ExoBridge("PlaybackProfiler", 9090, allow_lan=True)
        server = DummyServer(bridge)

        handler = DummyUploadHandler({"Origin": "https://any-origin.com"}, server)
        handler._set_cors_headers()
        self.assertEqual(handler._sent_headers.get("Access-Control-Allow-Origin"), "*")


if __name__ == "__main__":
    unittest.main()

