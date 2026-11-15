"""Tests for the ffprobe action (plan V7). Uses a local HTTP server and a fake ffprobe script."""

import os
import stat
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from bridge import ffprobe  # noqa: E402

PAYLOAD = bytes(range(256)) * 4  # 1024 bytes


class _RangeHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith("/redirect-ftp"):
            self.send_response(302)
            self.send_header("Location", "ftp://example.com/x")
            self.end_headers()
            return
        data = PAYLOAD
        range_header = self.headers.get("Range")
        status = 200
        if range_header and range_header.startswith("bytes="):
            start_s, _, end_s = range_header[len("bytes="):].partition("-")
            start = int(start_s)
            end = int(end_s) if end_s else len(PAYLOAD) - 1
            data = PAYLOAD[start:end + 1]
            status = 206
        self.send_response(status)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class _Server:
    def __enter__(self):
        self.httpd = HTTPServer(("127.0.0.1", 0), _RangeHandler)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


def _fake_ffprobe(directory, body):
    path = os.path.join(directory, "ffprobe")
    with open(path, "w") as f:
        f.write("#!/bin/sh\n" + body + "\n")
    os.chmod(path, stat.S_IRWXU)
    return path


OK_OUTPUT = 'echo \'{"format":{"format_name":"mov,mp4"},"streams":[{"codec_name":"h264","width":960,"height":540}]}\''


def _event(chunk_id, data_type, uri_raw, byte_start=0, byte_length=-1, track_format_id="5"):
    return {
        "category": "CHUNK", "event": "Loaded", "cat": "CHUNK", "event_name": "Loaded",
        "details": {
            "chunkId": chunk_id, "dataType": data_type, "trackType": "VIDEO",
            "trackFormatId": track_format_id, "uriRedacted": "https://h/<id>/x",
            "uriRaw": uri_raw, "byteStart": byte_start, "byteLength": byte_length,
        },
    }


class FindFfprobeTest(unittest.TestCase):
    def test_env_var_wins_when_executable(self):
        with tempfile.TemporaryDirectory() as d:
            exe = _fake_ffprobe(d, OK_OUTPUT)
            self.assertEqual(ffprobe.find_ffprobe(env={"FFPROBE": exe}, which=lambda _: None,
                                                   common_paths=()), exe)

    def test_env_var_pointing_nowhere_is_not_used(self):
        self.assertIsNone(ffprobe.find_ffprobe(env={"FFPROBE": "/nope/ffprobe"},
                                               which=lambda _: "/usr/bin/ffprobe"))

    def test_path_then_common_locations(self):
        self.assertEqual(ffprobe.find_ffprobe(env={}, which=lambda _: "/from/path"), "/from/path")
        self.assertIsNone(ffprobe.find_ffprobe(env={}, which=lambda _: None, common_paths=()))


class SelectChunksTest(unittest.TestCase):
    def setUp(self):
        self.events = [_event(1, "INIT", "https://cdn.example.com/a/init.mp4?token=T"),
                       _event(2, "MEDIA", "https://cdn.example.com/a/seg2.m4s?token=T")]

    def test_redacted_session_is_refused(self):
        with self.assertRaises(ffprobe.ProbeError) as ctx:
            ffprobe.select_chunks(self.events, [2], redacted=True)
        self.assertIn("redacted", str(ctx.exception))

    def test_unknown_chunk_is_refused(self):
        with self.assertRaises(ffprobe.ProbeError):
            ffprobe.select_chunks(self.events, [99], redacted=False)

    def test_non_http_scheme_is_refused(self):
        events = [_event(3, "MEDIA", "file:///etc/passwd")]
        with self.assertRaises(ffprobe.ProbeError):
            ffprobe.select_chunks(events, [3], redacted=False)

    def test_too_many_chunks_is_refused(self):
        with self.assertRaises(ffprobe.ProbeError):
            ffprobe.select_chunks(self.events, list(range(ffprobe.MAX_CHUNKS_PER_REQUEST + 1)))

    def test_selected_uri_comes_from_session_not_request(self):
        selected = ffprobe.select_chunks(self.events, ["2"], redacted=False)
        self.assertEqual(selected[0]["uriRaw"], "https://cdn.example.com/a/seg2.m4s?token=T")

    def test_init_chunk_is_found_by_track_format(self):
        init = ffprobe.find_init_chunk(self.events, "5")
        self.assertEqual(init["chunkId"], 1)
        self.assertIsNone(ffprobe.find_init_chunk(self.events, "7"))


class DownloadTest(unittest.TestCase):
    def test_range_download_writes_only_the_requested_bytes(self):
        with _Server() as srv, tempfile.TemporaryDirectory() as d:
            dest = os.path.join(d, "out")
            written = ffprobe.download_range(f"{srv.base}/seg", 10, 20, dest, ffprobe.build_opener())
            self.assertEqual(written, 20)
            with open(dest, "rb") as f:
                self.assertEqual(f.read(), PAYLOAD[10:30])

    def test_size_cap_stops_the_download(self):
        with _Server() as srv, tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ffprobe.ProbeError):
                ffprobe.download_range(f"{srv.base}/seg", 0, -1, os.path.join(d, "out"),
                                       ffprobe.build_opener(), max_bytes=100)

    def test_redirect_to_non_http_is_refused(self):
        with _Server() as srv, tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ffprobe.ProbeError) as ctx:
                ffprobe.download_range(f"{srv.base}/redirect-ftp", 0, -1, os.path.join(d, "out"),
                                       ffprobe.build_opener())
            self.assertNotIn("token", str(ctx.exception))

    def test_error_message_names_host_not_full_url(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ffprobe.ProbeError) as ctx:
                ffprobe.download_range("http://127.0.0.1:1/seg?token=SECRET", 0, -1,
                                       os.path.join(d, "out"), ffprobe.build_opener(), timeout=2)
            self.assertNotIn("SECRET", str(ctx.exception))


class RunFfprobeTest(unittest.TestCase):
    def test_parses_json_output(self):
        with tempfile.TemporaryDirectory() as d:
            exe = _fake_ffprobe(d, OK_OUTPUT)
            data = ffprobe.run_ffprobe(exe, os.path.join(d, "x.mp4"))
            self.assertEqual(data["streams"][0]["codec_name"], "h264")

    def test_timeout_is_reported(self):
        with tempfile.TemporaryDirectory() as d:
            exe = _fake_ffprobe(d, "sleep 5")
            with self.assertRaises(ffprobe.ProbeError) as ctx:
                ffprobe.run_ffprobe(exe, os.path.join(d, "x.mp4"), timeout=0.3)
            self.assertIn("timed out", str(ctx.exception))

    def test_nonzero_exit_is_reported(self):
        with tempfile.TemporaryDirectory() as d:
            exe = _fake_ffprobe(d, "echo bad input >&2; exit 1")
            with self.assertRaises(ffprobe.ProbeError):
                ffprobe.run_ffprobe(exe, os.path.join(d, "x.mp4"))


class ProbeChunksTest(unittest.TestCase):
    def test_probes_media_with_init_and_cleans_temp_files(self):
        with _Server() as srv, tempfile.TemporaryDirectory() as d:
            exe = _fake_ffprobe(d, OK_OUTPUT)
            events = [_event(1, "INIT", f"{srv.base}/init"),
                      _event(2, "MEDIA", f"{srv.base}/seg", byte_start=0, byte_length=64)]
            chunks = ffprobe.select_chunks(events, [2], redacted=False)
            tmp_root = os.path.join(d, "tmproot")
            os.makedirs(tmp_root)
            results = ffprobe.probe_chunks(chunks, events, ffprobe_path=exe, tmp_root=tmp_root)
            self.assertTrue(results[0]["ok"], results)
            self.assertEqual(results[0]["streams"][0]["codec_name"], "h264")
            self.assertEqual(os.listdir(tmp_root), [], "temp directory must be removed")

    def test_one_failing_chunk_does_not_abort_others(self):
        with _Server() as srv, tempfile.TemporaryDirectory() as d:
            exe = _fake_ffprobe(d, OK_OUTPUT)
            events = [_event(1, "MEDIA", f"{srv.base}/a"), _event(2, "MEDIA", "http://127.0.0.1:1/b")]
            chunks = ffprobe.select_chunks(events, [1, 2], redacted=False)
            results = ffprobe.probe_chunks(chunks, events, ffprobe_path=exe, tmp_root=d)
            self.assertTrue(results[0]["ok"])
            self.assertFalse(results[1]["ok"])
            self.assertIn("error", results[1])

    def test_missing_ffprobe_is_a_clear_error(self):
        with self.assertRaises(ffprobe.ProbeError) as ctx:
            ffprobe.probe_chunks([], [], ffprobe_path=None)
        self.assertIn("ffprobe was not found", str(ctx.exception))

    def test_encryption_markers_are_detected(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "enc.bin")
            with open(path, "wb") as f:
                f.write(b"\x00" * 100 + b"enca" + b"\x00" * 100)
            self.assertTrue(ffprobe.has_encryption_markers(path))


if __name__ == "__main__":
    unittest.main()
