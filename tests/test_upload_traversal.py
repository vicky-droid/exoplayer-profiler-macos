"""Path traversal regression tests for GET and DELETE on /uploads/<name>.

Each test runs the real HTTP handler on an ephemeral port. A "secret" file sits outside the uploads
folder, and every request tries to reach it. The file must never be read or deleted.
"""
import http.client
import os
import sys
import tempfile
import threading
import unittest
from http.server import HTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import bridge.bridge as bridge_mod  # noqa: E402
from bridge.bridge import UploadHandler  # noqa: E402


class _StubBridge:
    allow_lan = False

    def scan_uploaded_files(self):
        pass


class TraversalTest(unittest.TestCase):

    def setUp(self):
        self._outer = tempfile.TemporaryDirectory()
        base = self._outer.name
        self.uploads = os.path.join(base, "uploads")
        os.makedirs(self.uploads)
        self.secret = os.path.join(base, "secret.json")  # outside uploads, and it IS a .json file
        with open(self.secret, "w") as f:
            f.write('{"secret": true}')
        with open(os.path.join(self.uploads, "ok.json"), "w") as f:
            f.write('{"session": {"id": "ok"}, "events": []}')
        self.link = os.path.join(self.uploads, "link.json")
        os.symlink(self.secret, self.link)

        self._orig_upload_dir = bridge_mod.UPLOAD_DIR
        bridge_mod.UPLOAD_DIR = self.uploads
        self.server = HTTPServer(("127.0.0.1", 0), UploadHandler)
        self.server.bridge = _StubBridge()
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        bridge_mod.UPLOAD_DIR = self._orig_upload_dir
        self._outer.cleanup()

    def _request(self, method, raw_path):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request(method, raw_path)
        resp = conn.getresponse()
        body = resp.read()
        conn.close()
        return resp.status, body

    # --- GET: allowed -------------------------------------------------------

    def test_get_normal_upload_returns_content(self):
        status, body = self._request("GET", "/uploads/ok.json")
        self.assertEqual(status, 200)
        self.assertIn(b'"id": "ok"', body)

    # --- GET: traversal vectors must not read the secret --------------------

    def test_get_encoded_slash_traversal_refused(self):
        status, body = self._request("GET", "/uploads/..%2Fsecret.json")
        self.assertEqual(status, 400)
        self.assertNotIn(b"secret", body)

    def test_get_literal_relative_traversal_refused(self):
        status, body = self._request("GET", "/uploads/../secret.json")
        self.assertNotEqual(status, 200)
        self.assertNotIn(b"secret", body)

    def test_get_absolute_path_refused(self):
        status, body = self._request("GET", "/uploads/%2F" + self.secret.lstrip("/").replace("/", "%2F"))
        self.assertEqual(status, 400)
        self.assertNotIn(b"secret", body)

    def test_get_system_file_refused(self):
        status, body = self._request("GET", "/uploads/%2Fetc%2Fpasswd")
        self.assertEqual(status, 400)
        self.assertNotIn(b"root:", body)

    def test_get_backslash_refused(self):
        status, body = self._request("GET", "/uploads/..%5Csecret.json")
        self.assertEqual(status, 400)
        self.assertNotIn(b"secret", body)

    def test_get_dotfile_refused(self):
        with open(os.path.join(self.uploads, ".hidden.json"), "w") as f:
            f.write('{"hidden": true}')
        status, body = self._request("GET", "/uploads/.hidden.json")
        self.assertEqual(status, 400)
        self.assertNotIn(b"hidden", body)

    def test_get_symlink_escaping_uploads_refused(self):
        status, body = self._request("GET", "/uploads/link.json")
        self.assertEqual(status, 404)
        self.assertNotIn(b"secret", body)

    def test_get_non_json_name_refused(self):
        with open(os.path.join(self.uploads, "notes.txt"), "w") as f:
            f.write("plain")
        status, _ = self._request("GET", "/uploads/notes.txt")
        self.assertEqual(status, 400)

    # --- DELETE: must not remove anything outside uploads -------------------

    def test_delete_encoded_traversal_refused_and_secret_kept(self):
        status, _ = self._request("DELETE", "/uploads/..%2Fsecret.json")
        self.assertEqual(status, 400)
        self.assertTrue(os.path.exists(self.secret))

    def test_delete_symlink_refused_and_target_kept(self):
        status, _ = self._request("DELETE", "/uploads/link.json")
        self.assertEqual(status, 404)
        self.assertTrue(os.path.exists(self.secret))
        self.assertTrue(os.path.islink(self.link))

    def test_delete_normal_upload_still_works(self):
        status, _ = self._request("DELETE", "/uploads/ok.json")
        self.assertEqual(status, 200)
        self.assertFalse(os.path.exists(os.path.join(self.uploads, "ok.json")))


if __name__ == "__main__":
    unittest.main()
