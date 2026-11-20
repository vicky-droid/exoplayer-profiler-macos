"""Live ingest over the real WebSocket: sessions are saved once, acks cover accepted events only (plan 1.9)."""

import asyncio
import json
import os
import random
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import websockets  # noqa: E402

import bridge.bridge as bridge_mod  # noqa: E402
from bridge.schema import aggregates_from_events, document_hash, validate_session_document  # noqa: E402


def _event(t, category="CHUNK", name="Loaded", details=None):
    return {"tMs": t, "category": category, "event": name, "details": details or {}}


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _Harness(unittest.TestCase):
    """A bridge with its WebSocket server running on a background loop, and uploads in a temp folder."""

    def setUp(self):
        self._tmp = tempfile.mkdtemp(prefix="ingest_test_")
        self._patch = mock.patch.object(bridge_mod, "UPLOAD_DIR", self._tmp)
        self._patch.start()
        self._env = mock.patch.dict(os.environ, {"EXOPROFILER_LIVE_TOKEN": ""})
        self._env.start()
        self.port = _free_port()
        self.bridge = bridge_mod.ExoBridge("test", self.port, host="127.0.0.1", allow_lan=False)
        self.loop = asyncio.new_event_loop()
        self.bridge.loop = self.loop
        ready = threading.Event()

        async def start():
            return await websockets.serve(self.bridge.ws_handler, "127.0.0.1", self.port)

        def run():
            asyncio.set_event_loop(self.loop)
            self.server = self.loop.run_until_complete(start())
            ready.set()
            self.loop.run_forever()

        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()
        self.assertTrue(ready.wait(5))

    def tearDown(self):
        async def stop():
            self.server.close()
            await self.server.wait_closed()

        asyncio.run_coroutine_threadsafe(stop(), self.loop).result(5)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(5)
        self._env.stop()
        self._patch.stop()
        shutil.rmtree(self._tmp, ignore_errors=True)

    def connect(self):
        return websockets.connect(f"ws://127.0.0.1:{self.port}/ingest")

    def saved(self, session_id):
        path = os.path.join(self._tmp, f"{session_id}.json")
        if not os.path.exists(path):
            return None
        with open(path) as f:
            return json.load(f)

    def wait_saved(self, session_id, timeout=5.0):
        end = time.time() + timeout
        while time.time() < end:
            doc = self.saved(session_id)
            if doc is not None:
                return doc
            time.sleep(0.05)
        return None


class LiveIngestWebSocketTests(_Harness):

    def test_bye_saves_the_session_once_with_its_events_and_header(self):
        async def run():
            async with self.connect() as ws:
                await ws.send(json.dumps({"type": "hello", "sessionId": "sess-bye-0001", "schemaVersion": 3,
                                          "redacted": True, "device": {"manufacturer": "Google", "model": "Pixel"}}))
                self.assertEqual("hello", json.loads(await ws.recv())["type"])
                await ws.send(json.dumps({"type": "batch", "seq": 1,
                                          "events": [_event(200), _event(100), _event(300, "VIDEO", "RenderedFirstFrame")]}))
                ack = json.loads(await ws.recv())
                self.assertEqual({"type": "ack", "seq": 1, "accepted": 3}, ack)
                await ws.send(json.dumps({"type": "bye"}))
                bye = json.loads(await ws.recv())
                self.assertEqual({"type": "bye", "status": "ok", "saved": True}, bye)

        asyncio.run(run())
        doc = self.saved("sess-bye-0001")
        self.assertIsNotNone(doc)
        self.assertEqual((True, None), validate_session_document(doc))
        self.assertEqual([100, 200, 300], [e["tMs"] for e in doc["events"]])
        header = doc["session"]
        self.assertEqual("live", header["source"])
        self.assertEqual("bye", header["endReason"])
        self.assertEqual(3, header["eventCount"])
        self.assertEqual({"manufacturer": "Google", "model": "Pixel"}, header["device"])
        self.assertEqual(3, doc["aggregates"]["categoryCounts"]["CHUNK"] + doc["aggregates"]["categoryCounts"]["VIDEO"])
        self.assertEqual(document_hash(doc), doc["hash"])
        self.assertEqual(12, len(doc["hash"]))

    def test_disconnect_without_bye_still_saves_the_session(self):
        async def run():
            async with self.connect() as ws:
                await ws.send(json.dumps({"type": "hello", "sessionId": "sess-drop-0002"}))
                await ws.recv()
                await ws.send(json.dumps({"type": "batch", "seq": 1, "events": [_event(10), _event(20)]}))
                await ws.recv()
            # The socket is closed here, without bye.

        asyncio.run(run())
        doc = self.wait_saved("sess-drop-0002")
        self.assertIsNotNone(doc, "a dropped socket must still save what it sent")
        self.assertEqual("disconnect", doc["session"]["endReason"])
        self.assertEqual(2, len(doc["events"]))

    def test_ack_counts_only_accepted_events_and_invalid_events_are_not_saved(self):
        async def run():
            async with self.connect() as ws:
                await ws.send(json.dumps({"type": "hello", "sessionId": "sess-ack-0003"}))
                await ws.recv()
                await ws.send(json.dumps({"type": "batch", "seq": 1, "events": [
                    _event(10), {"tMs": "bad", "category": "CHUNK", "event": "Loaded"}, "not-an-object", _event(20)]}))
                ack = json.loads(await ws.recv())
                self.assertEqual({"type": "ack", "seq": 1, "accepted": 2}, ack)
                await ws.send(json.dumps({"type": "bye"}))
                await ws.recv()

        asyncio.run(run())
        self.assertEqual(2, len(self.saved("sess-ack-0003")["events"]))

    def test_duplicate_seq_is_rejected_without_an_ack_and_a_gap_is_recorded(self):
        async def run():
            async with self.connect() as ws:
                await ws.send(json.dumps({"type": "hello", "sessionId": "sess-seq-0004"}))
                await ws.recv()
                await ws.send(json.dumps({"type": "batch", "seq": 1, "events": [_event(10)]}))
                self.assertEqual("ack", json.loads(await ws.recv())["type"])
                await ws.send(json.dumps({"type": "batch", "seq": 1, "events": [_event(11)]}))
                err = json.loads(await ws.recv())
                self.assertEqual({"type": "error", "code": "duplicate_seq", "seq": 1}, err)
                # seq 2 and 3 are skipped; the next batch is seq 4.
                await ws.send(json.dumps({"type": "batch", "seq": 4, "events": [_event(40)]}))
                self.assertEqual({"type": "ack", "seq": 4, "accepted": 1}, json.loads(await ws.recv()))
                await ws.send(json.dumps({"type": "bye"}))
                await ws.recv()

        asyncio.run(run())
        doc = self.saved("sess-seq-0004")
        self.assertEqual([[2, 3]], doc["session"]["seqGaps"])
        self.assertEqual(1, doc["session"]["rejectedBatches"])
        self.assertEqual([10, 40], [e["tMs"] for e in doc["events"]])

    def test_a_second_hello_on_the_same_socket_is_refused(self):
        async def run():
            async with self.connect() as ws:
                await ws.send(json.dumps({"type": "hello", "sessionId": "sess-two-0005"}))
                await ws.recv()
                await ws.send(json.dumps({"type": "hello", "sessionId": "sess-other-0006"}))
                self.assertEqual({"type": "error", "code": "already_open"}, json.loads(await ws.recv()))
                await ws.send(json.dumps({"type": "bye"}))
                await ws.recv()

        asyncio.run(run())
        self.assertIsNotNone(self.saved("sess-two-0005"))
        self.assertIsNone(self.saved("sess-other-0006"))

    def test_batches_after_the_session_is_saved_are_refused(self):
        async def run():
            async with self.connect() as ws:
                await ws.send(json.dumps({"type": "hello", "sessionId": "sess-late-0007"}))
                await ws.recv()
                await ws.send(json.dumps({"type": "batch", "seq": 1, "events": [_event(10)]}))
                await ws.recv()
                # Stale expiry saves the session while the socket is still open.
                self.bridge.live_sessions.get_session("sess-late-0007").last_event_time -= 10_000
                self.loop.call_soon_threadsafe(lambda: self.bridge.expire_stale_live_sessions(max_age_seconds=300))
                await asyncio.sleep(0.3)
                await ws.send(json.dumps({"type": "batch", "seq": 2, "events": [_event(20)]}))
                self.assertEqual({"type": "error", "code": "session_closed"}, json.loads(await ws.recv()))

        asyncio.run(run())
        doc = self.saved("sess-late-0007")
        self.assertEqual("stale", doc["session"]["endReason"])
        self.assertEqual(1, len(doc["events"]))

    def test_a_failed_save_is_reported_and_retried_on_disconnect(self):
        real_write = bridge_mod.atomic_write_json
        calls = {"n": 0}

        def flaky(path, data):
            calls["n"] += 1
            if calls["n"] == 1:
                raise OSError("disk full")
            return real_write(path, data)

        async def run():
            async with self.connect() as ws:
                await ws.send(json.dumps({"type": "hello", "sessionId": "sess-retry-0008"}))
                await ws.recv()
                await ws.send(json.dumps({"type": "batch", "seq": 1, "events": [_event(10)]}))
                await ws.recv()
                await ws.send(json.dumps({"type": "bye"}))
                bye = json.loads(await ws.recv())
                self.assertEqual({"type": "bye", "status": "save_failed", "saved": False}, bye)
                self.assertIsNone(self.saved("sess-retry-0008"))
            # The socket closed; the disconnect path tries again and succeeds.

        with mock.patch.object(bridge_mod, "atomic_write_json", side_effect=flaky):
            asyncio.run(run())
        self.assertIsNotNone(self.wait_saved("sess-retry-0008"))
        self.assertEqual(2, calls["n"])


class LiveSessionUnitTests(unittest.TestCase):

    def test_aggregates_do_not_depend_on_event_order(self):
        events = [
            _event(100, "PLAYBACK", "StateChanged", {"state": 2}),
            _event(400, "PLAYBACK", "StateChanged", {"state": 3}),
            _event(500, "VIDEO", "RenderedFirstFrame"),
            _event(1_000, "PLAYBACK", "StateChanged", {"state": 2}),
            _event(1_800, "PLAYBACK", "StateChanged", {"state": 3}),
            _event(2_000, "VIDEO", "DroppedFrames", {"droppedFrames": 4}),
            _event(3_000, "PLAYBACK", "StateChanged", {"state": 2}),
            _event(4_500, "ERROR", "Error"),
        ]
        expected = aggregates_from_events(events)
        self.assertEqual(2, expected["rebufferCount"])
        self.assertEqual(800 + 1_500, expected["rebufferTotalMs"])
        self.assertEqual(4, expected["droppedFrames"])
        rng = random.Random(3)
        for _ in range(20):
            shuffled = events[:]
            rng.shuffle(shuffled)
            self.assertEqual(expected, aggregates_from_events(shuffled))


if __name__ == "__main__":
    unittest.main()
