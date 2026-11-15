import json
import subprocess
import threading
import asyncio
import websockets
import sys
import re
import os
import time
import urllib.parse
import logging
logging.getLogger("websockets.server").setLevel(logging.CRITICAL)
logging.getLogger("websockets.protocol").setLevel(logging.CRITICAL)
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn

from bridge.schema import detect_schema, normalise_session, normalise_event
from bridge import analysis, chunks, ffprobe

DEFAULT_TAGS = ["PlaybackProfiler", "ExoPlayer"]
DEFAULT_TAG = "PlaybackProfiler"
DEFAULT_PORT = 9090
DEFAULT_HOST = "127.0.0.1"

def extract_correlation_id(details):
    """Extract a correlation ID from event details dict if present."""
    if not isinstance(details, dict):
        return None
    for key in ("correlationId", "operationId", "requestId", "id", "sessionId", "adBreakId", "drmSessionId", "transactionId"):
        val = details.get(key)
        if val is not None and str(val).strip():
            return str(val).strip()
    return None

def parse_operations_from_events(events):
    """
    Generic suffix-based operation pairing engine for PlaybackProfiler events.
    Matches '<operation>_start' and '<operation>_end' events without hardcoding specific names.
    Supports correlation IDs, LIFO fallback for concurrency/overlapping ops, incomplete starts,
    unmatched ends, and normalized clock duration calculation.
    """
    if not events:
        return []

    pending_map = {}  # op_type -> list of start dicts
    operations = []

    for idx, evt in enumerate(events):
        evt_name = str(evt.get("event") or "").strip()

        if evt_name.endswith("_start"):
            op_type = evt_name[:-6]
            if not op_type:
                continue

            details = evt.get("details") or {}
            corr_id = extract_correlation_id(details)

            start_item = {
                "idx": idx,
                "op_type": op_type,
                "event": evt,
                "corr_id": corr_id,
            }
            if op_type not in pending_map:
                pending_map[op_type] = []
            pending_map[op_type].append(start_item)

        elif evt_name.endswith("_end"):
            op_type = evt_name[:-4]
            if not op_type:
                continue

            details = evt.get("details") or {}
            corr_id = extract_correlation_id(details)

            pending_list = pending_map.get(op_type, [])
            matched_start_item = None

            if pending_list:
                # 1. Match by correlation ID if available
                if corr_id is not None:
                    for i in range(len(pending_list) - 1, -1, -1):
                        if pending_list[i]["corr_id"] == corr_id:
                            matched_start_item = pending_list.pop(i)
                            break

                # 2. Fallback to LIFO (most recent pending start)
                if matched_start_item is None:
                    matched_start_item = pending_list.pop()

            if matched_start_item:
                start_evt = matched_start_item["event"]
                end_evt = evt

                start_time_ms = start_evt.get("timeMs")
                end_time_ms = end_evt.get("timeMs")

                start_ts_ms = start_evt.get("timestampMs") or (int(start_evt["ts"] * 1000) if "ts" in start_evt else None)
                end_ts_ms = end_evt.get("timestampMs") or (int(end_evt["ts"] * 1000) if "ts" in end_evt else None)

                # Clock normalization & duration calculation
                if end_time_ms is not None and start_time_ms is not None:
                    duration_ms = max(0, end_time_ms - start_time_ms)
                elif end_ts_ms is not None and start_ts_ms is not None:
                    duration_ms = max(0, end_ts_ms - start_ts_ms)
                elif "rel" in end_evt and "rel" in start_evt:
                    duration_ms = max(0, int((end_evt["rel"] - start_evt["rel"]) * 1000))
                else:
                    duration_ms = 0

                merged_details = {}
                if isinstance(start_evt.get("details"), dict):
                    merged_details.update(start_evt["details"])
                if isinstance(end_evt.get("details"), dict):
                    merged_details.update(end_evt["details"])
                merged_details["durationMs"] = duration_ms

                op_rec = {
                    "operation": op_type,
                    "status": "completed",
                    "startEvent": start_evt.get("event"),
                    "endEvent": end_evt.get("event"),
                    "category": start_evt.get("category") or end_evt.get("category") or op_type,
                    "startTimeMs": start_time_ms,
                    "endTimeMs": end_time_ms,
                    "durationMs": duration_ms,
                    "startTimestampMs": start_ts_ms,
                    "endTimestampMs": end_ts_ms,
                    "correlationId": corr_id or matched_start_item["corr_id"],
                    "startDetails": start_evt.get("details"),
                    "endDetails": end_evt.get("details"),
                    "details": merged_details,
                    "startIdx": matched_start_item["idx"],
                    "endIdx": idx,
                }
                operations.append(op_rec)
            else:
                # Unmatched end
                end_time_ms = evt.get("timeMs")
                end_ts_ms = evt.get("timestampMs") or (int(evt["ts"] * 1000) if "ts" in evt else None)
                op_rec = {
                    "operation": op_type,
                    "status": "unmatched_end",
                    "startEvent": None,
                    "endEvent": evt.get("event"),
                    "category": evt.get("category") or op_type,
                    "startTimeMs": None,
                    "endTimeMs": end_time_ms,
                    "durationMs": None,
                    "startTimestampMs": None,
                    "endTimestampMs": end_ts_ms,
                    "correlationId": corr_id,
                    "startDetails": None,
                    "endDetails": evt.get("details"),
                    "details": evt.get("details") or {},
                    "startIdx": None,
                    "endIdx": idx,
                }
                operations.append(op_rec)

    # Incomplete operations
    for op_type, pending_list in pending_map.items():
        for start_item in pending_list:
            start_evt = start_item["event"]
            start_time_ms = start_evt.get("timeMs")
            start_ts_ms = start_evt.get("timestampMs") or (int(start_evt["ts"] * 1000) if "ts" in start_evt else None)
            op_rec = {
                "operation": op_type,
                "status": "incomplete",
                "startEvent": start_evt.get("event"),
                "endEvent": None,
                "category": start_evt.get("category") or op_type,
                "startTimeMs": start_time_ms,
                "endTimeMs": None,
                "durationMs": None,
                "startTimestampMs": start_ts_ms,
                "endTimestampMs": None,
                "correlationId": start_item["corr_id"],
                "startDetails": start_evt.get("details"),
                "endDetails": None,
                "details": start_evt.get("details") or {},
                "startIdx": start_item["idx"],
                "endIdx": None,
            }
            operations.append(op_rec)

    operations.sort(key=lambda x: (
        x["startTimeMs"] if x["startTimeMs"] is not None else (x["endTimeMs"] or 0),
        x["startIdx"] if x["startIdx"] is not None else 0
    ))
    return operations


def parse_tags_arg(arg):
    tags = [t.strip() for t in (arg or "").split(",") if t.strip()]
    return tags or list(DEFAULT_TAGS)

def get_local_ip():
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(1)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        pass
    try:
        import socket as _s
        return _s.gethostbyname(_s.gethostname())
    except Exception:
        return "127.0.0.1"

def _find_adb():
    """Locate adb binary: env var > PATH > bundled fallback."""
    import shutil, os
    # 1. Environment variable override (most reliable)
    candidate = os.environ.get("EXOPROFILER_ADB_PATH")
    if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
        print(f"[ADB] _find_adb: found via EXOPROFILER_ADB_PATH = {candidate}")
        return candidate
    # 2. Fall back to system PATH
    adb_path = shutil.which("adb")
    if adb_path:
        print(f"[ADB] _find_adb: found via system PATH = {adb_path}")
        return adb_path
    # 3. Check common Android SDK installation paths
    common_locations = [
        os.path.expanduser("~/Library/Android/sdk/platform-tools/adb"),
        os.path.expanduser("~/Android/Sdk/platform-tools/adb"),
        "/usr/local/bin/adb",
        "/opt/homebrew/bin/adb",
    ]
    if sys.platform == "win32":
        local_app_data = os.environ.get("LOCALAPPDATA", "")
        if local_app_data:
            common_locations.append(os.path.join(local_app_data, "Android", "Sdk", "platform-tools", "adb.exe"))
    for loc in common_locations:
        if os.path.isfile(loc) and os.access(loc, os.X_OK):
            print(f"[ADB] _find_adb: found via common SDK path = {loc}")
            return loc
    # 4. Last resort: check PyInstaller bundled resources
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        bundled_dir = os.path.join(sys._MEIPASS, "resources", "adb")
        print(f"[ADB] _find_adb: checking bundled at {bundled_dir}")
        if os.path.isdir(bundled_dir):
            adb_file = os.path.join(bundled_dir, "adb")
            print(f"[ADB] _find_adb: bundled adb file exists={os.path.isfile(adb_file)}, executable={os.access(adb_file, os.X_OK) if os.path.isfile(adb_file) else 'N/A'}")
            if os.path.isfile(adb_file) and os.access(adb_file, os.X_OK):
                print(f"[ADB] _find_adb: found via bundled = {adb_file}")
                return adb_file
    print("[ADB] _find_adb: adb not found anywhere")
    return None

UPLOAD_DIR = os.environ.get("EXOPROFILER_UPLOAD_DIR") or os.path.join(
    os.path.expanduser("~"), "Documents", "ExoProfiler", "uploads"
)
os.makedirs(UPLOAD_DIR, exist_ok=True)

def _migrate_old_uploads():
    try:
        old_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "uploads")
        if os.path.abspath(old_dir) == os.path.abspath(UPLOAD_DIR):
            return
        if not os.path.isdir(old_dir):
            return
        existing = set(os.listdir(UPLOAD_DIR)) if os.path.isdir(UPLOAD_DIR) else set()
        for f in os.listdir(old_dir):
            if not f.endswith(".json"):
                continue
            if f in existing:
                continue
            try:
                with open(os.path.join(old_dir, f), "rb") as src, open(
                    os.path.join(UPLOAD_DIR, f), "wb"
                ) as dst:
                    dst.write(src.read())
            except OSError:
                pass
    except Exception:
        pass

_migrate_old_uploads()


class LiveSession:
    """Represents a live ingest session from a device via WebSocket.

    Tracks session metadata, event count, and enforces limits.
    """

    def __init__(self, session_id, schema_version, redacted, device, config):
        self.session_id = session_id
        self.schema_version = schema_version
        self.redacted = redacted
        self.device = device
        self.config = config or {}
        self.created_at = time.time()
        self.event_count = 0
        self.last_event_time = self.created_at
        self.events = []  # In-memory buffer for live events
        self.is_active = True

    def add_event(self, event):
        """Add an event to this session. Returns True if accepted, False if limits exceeded."""
        max_events = self.config.get("max_events", 200000)
        if self.event_count >= max_events:
            return False
        self.events.append(event)
        self.event_count += 1
        self.last_event_time = time.time()
        return True

    def finalize(self):
        """Mark session as ended and return a summary dict."""
        self.is_active = False
        return {
            "session_id": self.session_id,
            "event_count": self.event_count,
            "started_at": self.created_at,
            "ended_at": time.time(),
            "duration_ms": int((time.time() - self.created_at) * 1000),
        }

    def get_summary(self):
        return {
            "id": self.session_id,
            "schema_version": self.schema_version,
            "redacted": self.redacted,
            "device": self.device,
            "config": self.config,
            "started_at": self.created_at,
            "event_count": self.event_count,
            "is_active": self.is_active,
        }


class LiveSessionManager:
    """Manages active live ingest sessions with limits."""

    def __init__(self, max_sessions=50, max_events_per_session=200000):
        self.sessions = {}  # session_id -> LiveSession
        self.max_sessions = max_sessions
        self.max_events_per_session = max_events_per_session

    def create_session(self, session_id, schema_version, redacted, device, config=None):
        """Create a new live session. Returns (session, error_message)."""
        if session_id in self.sessions:
            return self.sessions[session_id], None  # Reuse existing
        if len(self.sessions) >= self.max_sessions:
            return None, "session_limit_reached"
        session = LiveSession(session_id, schema_version, redacted, device, config)
        self.sessions[session_id] = session
        return session, None

    def get_session(self, session_id):
        return self.sessions.get(session_id)

    def remove_session(self, session_id):
        self.sessions.pop(session_id, None)

    def get_active_sessions(self):
        return {sid: s.get_summary() for sid, s in self.sessions.items() if s.is_active}

    def cleanup_stale(self, max_age_seconds=300):
        """Remove sessions inactive for too long."""
        now = time.time()
        stale = [
            sid
            for sid, s in self.sessions.items()
            if now - s.last_event_time > max_age_seconds
        ]
        for sid in stale:
            self.remove_session(sid)
        return stale


def _base_dir():
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return sys._MEIPASS
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

def _app_version():
    for candidate in (
        os.path.join(_base_dir(), "VERSION"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "VERSION"),
    ):
        try:
            with open(candidate, "r") as f:
                v = f.read().strip()
                if v:
                    return v
        except OSError:
            continue
    return "dev"

APP_VERSION = _app_version()
DASHBOARD_DIR = os.path.join(_base_dir(), "dashboard")
ASSETS_DIR = os.path.join(_base_dir(), "assets")

class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

def atomic_write_json(filepath, data):
    """Atomically write JSON to a file using temp file + rename."""
    tmp_path = filepath + ".tmp"
    try:
        with open(tmp_path, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_path, filepath)
    except Exception:
        # Clean up temp file on failure
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass

def resolve_lan_policy(allow_lan, env):
    """LAN mode is only honoured when both ingest tokens are set (plan V2).

    Returns (allow_lan, warning). Without both tokens the bridge stays on localhost.
    """
    if not allow_lan:
        return False, None
    if env.get("EXOPROFILER_UPLOAD_TOKEN") and env.get("EXOPROFILER_LIVE_TOKEN"):
        return True, None
    return False, ("LAN mode needs both EXOPROFILER_UPLOAD_TOKEN and EXOPROFILER_LIVE_TOKEN; "
                   "staying on localhost.")


def _safe_session_filename(session_id):
    return re.sub(r'[^a-zA-Z0-9_\-]', '_', str(session_id)) + ".json"


def find_session_events(bridge, session_id):
    """Normalised events for a live or saved session.

    Returns (events, redacted, found). Live sessions are checked first, then saved uploads.
    """
    live = bridge.live_sessions.get_session(session_id) if bridge and hasattr(bridge, "live_sessions") else None
    if live is not None:
        return [normalise_event(e) for e in live.events], bool(live.redacted), True
    path = os.path.join(UPLOAD_DIR, _safe_session_filename(session_id))
    if os.path.exists(path):
        with open(path, "r") as f:
            normalised = normalise_session(json.load(f))
        return normalised["events"], bool(normalised.get("redacted")), True
    return [], True, False


def _flag(params, name):
    return params.get(name, ["0"])[0] in ("1", "true", "yes")


class UploadHandler(BaseHTTPRequestHandler):

    def _set_cors_headers(self):
        bridge = getattr(self.server, "bridge", None)
        allow_lan = getattr(bridge, "allow_lan", False) if bridge else (
            os.environ.get("EXOPROFILER_ALLOW_LAN", "0").lower() in ("1", "true", "yes")
        )
        if allow_lan:
            self.send_header("Access-Control-Allow-Origin", "*")
            return

        origin = self.headers.get("Origin") if hasattr(self, "headers") and self.headers else None
        if origin:
            parsed = urllib.parse.urlparse(origin)
            if parsed.hostname in ("localhost", "127.0.0.1", "::1"):
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")

    def do_OPTIONS(self):
        self.send_response(200)
        self._set_cors_headers()
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS, DELETE")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Profiler-Session")
        self.end_headers()

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/ffprobe":
            self._handle_ffprobe()
            return
        if path.startswith("/api/v3/sessions/") and path.endswith("/analysis"):
            self._handle_session_api(path, method="POST")
            return
        if path == "/api/v3/sessions":
            # Token validation (optional - if EXOPROFILER_UPLOAD_TOKEN env var is set)
            auth_header = self.headers.get("Authorization", "")
            expected_token = os.environ.get("EXOPROFILER_UPLOAD_TOKEN")
            if expected_token:
                provided_token = auth_header.replace("Bearer ", "") if auth_header.startswith("Bearer ") else auth_header
                if provided_token != expected_token:
                    self._send_json({"status": "error", "message": "Unauthorized"}, status=401)
                    return
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                data = json.loads(body)
                sess_id = data.get("session", {}).get("id") or data.get("id")
                if not sess_id:
                    self._send_json({"status": "error", "message": "Missing session id"}, status=400)
                    return
                bridge = getattr(self.server, "bridge", None)
                if not bridge or not hasattr(bridge, "live_sessions"):
                    self._send_json({"status": "error", "message": "Bridge not available"}, status=500)
                    return
                session, error = bridge.live_sessions.create_session(
                    sess_id,
                    data.get("schemaVersion", 3),
                    data.get("redacted", True),
                    data.get("session", {}).get("device", {}),
                    data.get("config", {}),
                )
                if error:
                    self._send_json({"status": "error", "message": error}, status=400)
                    return
                self._send_json({"status": "ok", "filename": f"{sess_id}.json", "duplicate": False})
            except json.JSONDecodeError:
                self._send_json({"status": "error", "message": "Invalid JSON"}, status=400)
            except Exception as e:
                self._send_json({"status": "error", "message": str(e)}, status=500)
            return
        if path in ("/upload", "/save-session"):
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            try:
                data = json.loads(body)
                sess_id = ""
                if isinstance(data, dict):
                    if "events" in data and isinstance(data["events"], list):
                        data["operations"] = parse_operations_from_events(data["events"])
                        if "session" in data and isinstance(data["session"], dict):
                            data["session"]["operationCount"] = len(data["operations"])
                    if "session" in data and isinstance(data["session"], dict):
                        sess_id = data["session"].get("id", "")
                    elif "id" in data:
                        sess_id = data["id"]
                if sess_id:
                    safe_id = re.sub(r'[^a-zA-Z0-9_\-]', '_', str(sess_id))
                    filename = f"{safe_id}.json"
                else:
                    filename = f"upload_{int(time.time())}.json"
                filepath = os.path.join(UPLOAD_DIR, filename)
                atomic_write_json(filepath, data)
                if hasattr(self.server, "bridge") and self.server.bridge:
                    self.server.bridge.scan_uploaded_files()
                self._send_json({"status": "ok", "filename": filename})
            except json.JSONDecodeError:
                self._send_json({"status": "error", "message": "Invalid JSON"}, status=400)
            except Exception as e:
                self._send_json({"status": "error", "message": str(e)}, status=500)
        else:
            self.send_response(404)
            self.send_header("Content-Type", "text/plain")
            self._set_cors_headers()
            self.end_headers()

    def _read_json_body(self, limit=256 * 1024):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length > limit:
            raise ValueError("request body too large")
        return json.loads(self.rfile.read(length) or b"{}")

    def _session_id_from_path(self, path, suffix):
        return urllib.parse.unquote(path[len("/api/v3/sessions/"):-len(suffix)])

    def _handle_session_api(self, path, method):
        parsed = urllib.parse.urlparse(self.path)
        bridge = getattr(self.server, "bridge", None)
        suffix = "/chunks" if path.endswith("/chunks") else "/analysis"
        session_id = self._session_id_from_path(parsed.path, suffix)
        events, redacted, found = find_session_events(bridge, session_id)
        if not found:
            self._send_json({"status": "error", "message": "Session not found"}, status=404)
            return
        rows = chunks.extract_rows(events)
        if suffix == "/chunks":
            params = urllib.parse.parse_qs(parsed.query)
            rows = chunks.filter_rows(
                rows,
                track_type=params.get("track", [None])[0],
                outcome=params.get("outcome", [None])[0],
                errors_only=_flag(params, "errorsOnly"),
                gaps_only=_flag(params, "gapsOnly"),
                slow_only=_flag(params, "slow"),
                kind=params.get("kind", [None])[0],
                text=params.get("q", [None])[0],
            )
            if params.get("format", [""])[0] == "csv":
                body = chunks.to_csv(rows).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Content-Disposition", "attachment; filename=chunks.csv")
                self._set_cors_headers()
                self.end_headers()
                self.wfile.write(body)
                return
            self._send_json({"redacted": redacted, "rows": rows, "summary": chunks.summary(rows)})
            return
        # analysis
        rules = analysis.DEFAULT_RULES
        if method == "POST":
            try:
                body = self._read_json_body()
            except (ValueError, json.JSONDecodeError) as e:
                self._send_json({"status": "error", "message": f"Invalid request: {e}"}, status=400)
                return
            rules = body.get("rules", rules)
            problems = analysis.validate_rules(rules)
            if problems:
                self._send_json({"status": "error", "message": "; ".join(problems)}, status=400)
                return
        self._send_json({
            "redacted": redacted,
            "formats": analysis.formats_view(events),
            "rules": analysis.evaluate_rules(rules, events, rows),
        })

    def _handle_ffprobe(self):
        bridge = getattr(self.server, "bridge", None)
        try:
            body = self._read_json_body()
        except (ValueError, json.JSONDecodeError) as e:
            self._send_json({"status": "error", "message": f"Invalid request: {e}"}, status=400)
            return
        session_id = body.get("sessionId")
        events, redacted, found = find_session_events(bridge, session_id) if session_id else ([], True, False)
        if not found:
            self._send_json({"status": "error", "message": "Session not found"}, status=404)
            return
        try:
            selected = ffprobe.select_chunks(events, body.get("chunkIds", []), redacted=redacted)
            results = ffprobe.probe_chunks(
                selected, events, ffprobe_path=ffprobe.find_ffprobe(), opener=ffprobe.build_opener(),
            )
        except ffprobe.ProbeError as e:
            self._send_json({"status": "error", "message": str(e)}, status=400)
            return
        self._send_json({"status": "ok", "results": results})

    def do_DELETE(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/v3/sessions":
            # Delete a live session by ID
            sess_id = urllib.parse.unquote(path[len("/api/v3/sessions/"):])
            bridge = getattr(self.server, "bridge", None)
            if not bridge or not hasattr(bridge, "live_sessions"):
                self._send_json({"status": "error", "message": "Bridge not available"}, status=500)
                return
            bridge.live_sessions.remove_session(sess_id)
            self._send_json({"status": "ok"})
            return
        if not path.startswith("/uploads/"):
            self._send_json({"status": "error", "message": "Not found"}, status=404)
            return
        filename = urllib.parse.unquote(path[len("/uploads/"):])
        if (not filename or "/" in filename or "\\" in filename
                or filename.startswith(".") or not filename.endswith(".json")):
            self._send_json({"status": "error", "message": "Invalid filename"}, status=400)
            return
        filepath = os.path.join(UPLOAD_DIR, filename)
        if not os.path.exists(filepath):
            fallback = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "..", "uploads", filename
            )
            if os.path.exists(fallback):
                filepath = fallback
        if not os.path.exists(filepath):
            self._send_json({"status": "error", "message": "File not found"}, status=404)
            return
        try:
            os.remove(filepath)
            bridge = getattr(self.server, "bridge", None)
            if bridge:
                bridge.scan_uploaded_files()
            self._send_json({"status": "ok", "filename": filename})
        except Exception as e:
            self._send_json({"status": "error", "message": str(e)}, status=500)

    def _send_json(self, obj, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self._set_cors_headers()
        self.end_headers()
        self.wfile.write(json.dumps(obj).encode())

    def _serve_asset(self, filename, content_type):
        allowed = {"favicon.png"}
        if filename not in allowed:
            self.send_response(404)
            self.end_headers()
            return
        filepath = os.path.join(ASSETS_DIR, filename)
        if not os.path.exists(filepath):
            fallback = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "..", "assets", filename
            )
            if os.path.exists(fallback):
                filepath = fallback
        if not os.path.exists(filepath):
            self.send_response(404)
            self.end_headers()
            return
        try:
            with open(filepath, "rb") as f:
                content = f.read()
        except OSError:
            self.send_response(500)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "max-age=86400")
        self.end_headers()
        self.wfile.write(content)

    def _serve_dashboard_file(self, filename):
        allowed = {"index.html", "exoplayer_profiler_v4.html"}
        if filename not in allowed:
            self.send_response(404)
            self.end_headers()
            return
        filepath = os.path.join(DASHBOARD_DIR, filename)
        if not os.path.exists(filepath):
            fallback = os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "..", "dashboard", filename
            )
            if os.path.exists(fallback):
                filepath = fallback
        if not os.path.exists(filepath):
            self.send_response(404)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"Dashboard file not found")
            return
        try:
            with open(filepath, "rb") as f:
                content = f.read()
        except OSError:
            self.send_response(500)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/favicon.ico", "/favicon.png"):
            self._serve_asset("favicon.png", "image/png")
            return
        if path in ("/", "/index.html"):
            self._serve_dashboard_file("index.html")
            return
        if path in ("/exoplayer_profiler_v4.html", "/exoplayer_profiler_v3.html"):
            self._serve_dashboard_file(path.lstrip("/"))
            return
        if path == "/version":
            self._send_json({"version": APP_VERSION})
            return
        if path.startswith("/api/v3/sessions/") and (path.endswith("/chunks") or path.endswith("/analysis")):
            self._handle_session_api(path, method="GET")
            return
        if path == "/uploaded-files":
            files = list(self.server.bridge.uploaded_files) if hasattr(self.server, 'bridge') else []
            self._send_json({"files": files})
            return
        elif path == "/select-device":
            query = urllib.parse.urlparse(self.path).query
            params = urllib.parse.parse_qs(query)
            device_id = params.get("id", [None])[0]
            bridge = getattr(self.server, "bridge", None)
            if bridge and device_id:
                bridge.set_target_device(device_id)
                self._send_json({"status": "ok", "target_device": device_id})
            else:
                self._send_json({"status": "error", "message": "Missing device id or bridge"}, status=400)
            return
        elif path == "/adb-devices":
            devices, adb_ok, msg = get_adb_devices()
            lan = get_local_ip()
            bridge = getattr(self.server, "bridge", None)
            tags = bridge.tags if bridge else DEFAULT_TAGS
            port = bridge.port if bridge else DEFAULT_PORT
            target = getattr(bridge, "target_device", None) if bridge else None
            self._send_json({
                "devices": devices,
                "target_device": target,
                "adb_available": adb_ok,
                "message": msg,
                "tags": tags,
                "local_ip": lan,
                "ws_url": f"ws://{lan}:{port}",
                "http_url": f"http://{lan}:{port + 1}"
            })
            return
        elif path == "/net-info":
            lan = get_local_ip()
            bridge = getattr(self.server, "bridge", None)
            port = bridge.port if bridge else DEFAULT_PORT
            self._send_json({
                "local_ip": lan,
                "ws_url": f"ws://{lan}:{port}",
                "http_url": f"http://{lan}:{port + 1}",
                "ws_local": f"ws://localhost:{port}",
                "http_local": f"http://localhost:{port + 1}",
                "version": APP_VERSION
            })
            return
        elif path == "/api/v3/sessions":
            bridge = getattr(self.server, "bridge", None)
            if bridge and hasattr(bridge, "live_sessions"):
                sessions = bridge.live_sessions.get_active_sessions()
                self._send_json({"sessions": list(sessions.values())})
            else:
                self._send_json({"sessions": []})
            return
        elif path.startswith("/uploads/"):
            filename = path[len("/uploads/"):]
            filename = urllib.parse.unquote(filename)
            filepath = os.path.join(UPLOAD_DIR, filename)
            if not os.path.exists(filepath):
                fallback = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "uploads", filename)
                if os.path.exists(fallback):
                    filepath = fallback
            if os.path.exists(filepath):
                try:
                    with open(filepath, "r") as f:
                        content = f.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self._set_cors_headers()
                    self.end_headers()
                    self.wfile.write(content.encode())
                    return
                except Exception as e:
                    self.send_response(500)
                    self.send_header("Content-Type", "text/plain")
                    self._set_cors_headers()
                    self.end_headers()
                    self.wfile.write(f"Read error: {e}".encode())
                    return
            else:
                self.send_response(404)
                self.send_header("Content-Type", "text/plain")
                self._set_cors_headers()
                self.end_headers()
                self.wfile.write(b"File not found")
        else:
            self.send_response(404)
            self.send_header("Content-Type", "text/plain")
            self._set_cors_headers()
            self.end_headers()

    def log_message(self, format, *args):
        pass

class ExoBridge:
    def __init__(self, tag, port, host=None, allow_lan=None):
        if isinstance(tag, (list, tuple)):
            self.tags = list(tag) or list(DEFAULT_TAGS)
        else:
            self.tags = parse_tags_arg(tag) if "," in str(tag) else [str(tag)]
        self.tag = self.tags[0]
        self.port = port
        if allow_lan is None:
            requested_lan = os.environ.get("EXOPROFILER_ALLOW_LAN", "0").lower() in ("1", "true", "yes")
        else:
            requested_lan = bool(allow_lan)
        self.allow_lan, lan_warning = resolve_lan_policy(requested_lan, os.environ)
        if lan_warning:
            print(f"⚠ {lan_warning}")
        if host is None:
            env_host = os.environ.get("EXOPROFILER_HOST")
            if env_host:
                self.host = env_host
            else:
                self.host = "0.0.0.0" if self.allow_lan else DEFAULT_HOST
        else:
            self.host = host
        self.clients = set()
        self.loop = None
        self.uploaded_files = set()
        self.live_events_buffer = []
        self.pending_chunks = {}
        self.live_sessions = LiveSessionManager()
        self.start_time = time.time()
        self.target_device = None
        self.logcat_proc = None
        self.scan_uploaded_files()

    def set_target_device(self, device_id):
        print(f"🎯 Target device set to: {device_id}")
        self.target_device = device_id
        self.setup_adb_reverse(device_id)
        if self.logcat_proc:
            try:
                self.logcat_proc.terminate()
            except Exception:
                pass

    def setup_adb_reverse(self, device_id=None):
        adb = _find_adb()
        if not adb:
            return
        target = device_id or self.target_device
        cmd_base = [adb]
        if target:
            cmd_base += ["-s", target]
        try:
            import subprocess
            subprocess.run(cmd_base + ["reverse", f"tcp:{self.port}", f"tcp:{self.port}"], capture_output=True, timeout=2)
            subprocess.run(cmd_base + ["reverse", f"tcp:{self.port + 1}", f"tcp:{self.port + 1}"], capture_output=True, timeout=2)
            print(f"🔄 Configured adb reverse for {target or 'default device'}")
        except Exception as e:
            print(f"⚠ adb reverse warning: {e}")

    async def register(self, websocket):
        self.clients.add(websocket)
        try:
            await websocket.wait_closed()
        finally:
            self.clients.discard(websocket)
            if not self.clients and len(self.live_events_buffer) >= 2:
                self.save_live_session(reason="client_disconnect")

    def save_live_session(self, reason="auto"):
        if len(self.live_events_buffer) < 2:
            return None
        now_ts = time.time()
        now_dt = time.strftime("%Y%m%d_%H%M%S")
        filename = f"session_live_{now_dt}.json"
        filepath = os.path.join(UPLOAD_DIR, filename)

        first_ts = self.live_events_buffer[0].get("ts", now_ts)
        last_ts = self.live_events_buffer[-1].get("ts", now_ts)
        duration_ms = max(1000, int((last_ts - first_ts) * 1000))

        session_events = []
        for e in self.live_events_buffer:
            if e.get("timeMs") is not None:
                time_ms = int(e["timeMs"])
            elif e.get("tMs") is not None:
                time_ms = int(e["tMs"])
            else:
                rel = e.get("rel", 0)
                time_ms = int(rel) if rel > 100 else int(rel * 1000)
            ts_ms = int(e.get("ts", now_ts) * 1000) if e.get("ts") else int(e.get("timestampMs") or e.get("wall") or (now_ts * 1000))
            category = e.get("category") or e.get("cat") or "Live"
            session_events.append({
                "timeMs": time_ms,
                "tMs": time_ms,
                "rel": time_ms,
                "timestampMs": ts_ms,
                "wallMs": ts_ms,
                "category": category,
                "cat": category,
                "event": e.get("event") or "Log",
                "thread": e.get("tag") or "live",
                "details": e.get("details") or {}
            })

        if session_events:
            current_t0 = 0
            for ev in session_events:
                if ev.get("event") in ("SessionStarted", "SessionStart", "playback_request"):
                    current_t0 = ev["timeMs"] if ev.get("timeMs") is not None else 0
                elif current_t0 == 0 and ev.get("timeMs") is not None:
                    current_t0 = ev["timeMs"]
                if current_t0 > 0 and ev.get("timeMs") is not None:
                    ev["timeMs"] = max(0, ev["timeMs"] - current_t0)
                    ev["tMs"] = ev["timeMs"]
                    ev["rel"] = ev["timeMs"]
            duration_ms = max(duration_ms, session_events[-1]["timeMs"] + 500)

        operations = parse_operations_from_events(session_events)

        # Extract device info and real session ID from SessionStarted event if present
        device_label = "live-adb"
        real_session_id = f"live_{now_dt}"
        for ev in session_events:
            if ev.get("event") in ("SessionStarted", "SessionStart") and ev.get("category") in ("SESSION", "Session"):
                d = ev.get("details") or {}
                if d.get("device"):
                    device_label = d["device"]
                if d.get("sessionId"):
                    real_session_id = d["sessionId"]
                break

        session_doc = {
            "schemaVersion": 3,
            "session": {
                "id": real_session_id,
                "packageName": device_label,
                "startedAtEpochMs": int(first_ts * 1000),
                "exportedAtEpochMs": int(last_ts * 1000),
                "durationMs": duration_ms,
                "eventCount": len(session_events),
                "operationCount": len(operations),
                "saveReason": reason
            },
            "events": session_events,
            "operations": operations
        }
        try:
            with open(filepath, "w") as f:
                json.dump(session_doc, f, indent=2)
            self.scan_uploaded_files()
            print(f"💾 Auto-saved live session to {filename} ({len(session_events)} events, reason: {reason})")
            return filename
        except Exception as err:
            print(f"⚠ Failed to auto-save live session: {err}")
            return None

    async def broadcast(self, message):
        if not self.clients:
            return
        results = await asyncio.gather(*[client.send(message) for client in list(self.clients)], return_exceptions=True)
        for client, res in zip(list(self.clients), results):
            if isinstance(res, Exception):
                self.clients.discard(client)

    def parse_log_line(self, line):
        line = line.strip()
        if not line:
            return None
        matched_tag = None
        content = None
        for t in self.tags:
            if f" {t}:" in line or f"/{t}:" in line:
                matched_tag = t
                content = line.rsplit(f"{t}:", 1)[-1].strip()
                break
            elif f"/{t}(" in line or f" {t}(" in line:
                matched_tag = t
                content = line.split("):", 1)[-1].strip() if "):" in line else line.rsplit(":", 1)[-1].strip()
                break
        if not matched_tag:
            return None
        # SDK sink diagnostics ("LiveSink WebSocket closed", "Upload successful ...") are not playback events.
        if content and re.match(r"^(LiveSink|FileSink|UploadSink|Upload successful)", content):
            return None
        now = time.time()
        ts_ms = int(now * 1000)
        base = {"ts": now, "timestampMs": ts_ms, "tag": matched_tag, "raw": line}
        m = re.match(r'^(?:(\d+)\s*ms\s+)?(?:\[([^\]]+)\]\s+)?(\S+)\s*(\{.*\})?\s*$', content or "")
        if m:
            ms, category, event_name, json_blob = m.groups()
            details = {}
            if json_blob:
                try:
                    details = json.loads(json_blob)
                except json.JSONDecodeError:
                    details = {"_raw": json_blob}
            if isinstance(details, dict) and "__profilerChunkId" in details:
                chunk_id = str(details.get("__profilerChunkId"))
                try:
                    chunk_index = int(details.get("__profilerChunk", 0))
                    chunk_total = int(details.get("__profilerChunks", 1))
                except (TypeError, ValueError):
                    return None
                if len(self.pending_chunks) > 32:
                    self.pending_chunks.clear()
                entry = self.pending_chunks.setdefault(
                    chunk_id, {"total": chunk_total, "parts": {}}
                )
                entry["total"] = chunk_total
                entry["parts"][chunk_index] = str(details.get("data", ""))
                if len(entry["parts"]) < chunk_total:
                    return None
                payload = "".join(entry["parts"].get(i, "") for i in range(chunk_total))
                self.pending_chunks.pop(chunk_id, None)
                try:
                    details = json.loads(payload)
                except json.JSONDecodeError:
                    details = {"_raw": payload}
            if isinstance(details, dict) and "details" in details and isinstance(details["details"], dict):
                inner_det = details.pop("details")
                details.update(inner_det)
            if "timestampMs" in details and isinstance(details["timestampMs"], (int, float)):
                ts_ms = int(details["timestampMs"])
            time_ms = None
            if ms is not None:
                try:
                    time_ms = int(ms)
                    rel = round(time_ms / 1000.0, 2)
                except ValueError:
                    rel = round(now - self.start_time, 2)
            else:
                rel = round(now - self.start_time, 2)
            if "timeMs" in details and time_ms is None and isinstance(details["timeMs"], (int, float)):
                time_ms = int(details["timeMs"])
                rel = round(time_ms / 1000.0, 2)
            return {**base, "timestampMs": ts_ms, "event": event_name, "category": category or "", "rel": rel, "timeMs": time_ms, "details": details}
        m2 = re.match(r'^([^:]+):\s*(.*)$', content or "")
        if not m2:
            return {**base, "event": content[:60] or "Log", "category": "", "rel": round(now - self.start_time, 2), "timeMs": None, "details": {}}
        event_name = m2.group(1).strip()
        details_str = m2.group(2).strip()
        details = {}
        if details_str.startswith("{"):
            try:
                details = json.loads(details_str)
            except json.JSONDecodeError:
                details = {"_raw": details_str}
        else:
            for pair in details_str.split(", "):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    details[k.strip()] = v.strip()
                elif ":" in pair:
                    k, v = pair.split(":", 1)
                    details[k.strip()] = v.strip()
        if "timestampMs" in details and isinstance(details["timestampMs"], (int, float)):
            ts_ms = int(details["timestampMs"])
        if "timeMs" in details and isinstance(details["timeMs"], (int, float)):
            time_ms = int(details["timeMs"])
            rel = round(time_ms / 1000.0, 2)
        else:
            time_ms = None
            rel = round(now - self.start_time, 2)
        return {**base, "timestampMs": ts_ms, "event": event_name, "category": "", "rel": rel, "timeMs": time_ms, "details": details}

    def auto_detect_target(self):
        devs, _, _ = get_adb_devices()
        online_devs = [d["id"] for d in devs if d.get("state") == "device"]
        if not online_devs:
            return None
        adb = _find_adb()
        if adb:
            import subprocess
            for d_id in online_devs:
                try:
                    res = subprocess.run([adb, "-s", d_id, "shell", "pidof", "com.firstlight.vstb7.mobile"], capture_output=True, text=True, timeout=1.5)
                    if res.stdout.strip():
                        return d_id
                except Exception:
                    pass
        return online_devs[0]

    def logcat_cmd(self):
        adb = _find_adb()
        if not adb:
            raise FileNotFoundError("adb binary not found")
        cmd = [adb]
        target = self.target_device or self.auto_detect_target()
        if target:
            self.target_device = target
            cmd += ["-s", target]
        cmd += ["logcat", "-s"] + [f"{t}:*" for t in self.tags]
        return cmd

    async def tail_adb(self):
        while True:
            if not self.target_device:
                target = self.auto_detect_target()
                if target:
                    self.target_device = target
                    self.setup_adb_reverse(target)
            try:
                cmd = self.logcat_cmd()
                process = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE
                )
                self.logcat_proc = process
            except FileNotFoundError:
                print("⚠ adb not found — live events paused (dashboard still works). Retrying in 5s…")
                await asyncio.sleep(5)
                continue
            except Exception as e:
                print(f"⚠ tail_adb start failed ({e}). Retrying in 5s…")
                await asyncio.sleep(5)
                continue
            try:
                async for line in process.stdout:
                    line_str = line.decode('utf-8').strip()
                    event = self.parse_log_line(line_str)
                    if event:
                        # Normalise through schema normaliser
                        normalised = normalise_session(event)
                        norm_event = normalised['events'][0] if normalised['events'] else event
                        print(f"📡 Emitting live event: {norm_event.get('event')} ({norm_event.get('cat')})")
                        ev_cat = norm_event.get("cat")
                        ev_name = norm_event.get("event")
                        if ev_cat == "Session" and ev_name == "SessionStarted":
                            self.live_events_buffer = []
                        self.live_events_buffer.append(norm_event)
                        if len(self.live_events_buffer) > 3000:
                            self.live_events_buffer = self.live_events_buffer[-3000:]
                        if ev_name == "SessionEnded" or ev_name in ("Ended", "SessionReleased", "release", "playerReleased", "PlaybackEnded"):
                            self.save_live_session(reason="session_ended")
                            self.live_events_buffer = []
                        # With an SDK ingest connection active, its batches are the source of truth.
                        # Broadcasting logcat lines too would double every event in the live view.
                        if getattr(self, "ingest_connections", 0) == 0:
                            await self.broadcast(json.dumps(norm_event))
            except Exception as e:
                print(f"⚠ tail_adb error ({e}). Restarting in 2s…")
                if len(self.live_events_buffer) >= 2:
                    self.save_live_session(reason="tail_adb_error")
                await asyncio.sleep(2)
                continue
            print("⚠ adb logcat exited. Restarting in 2s…")
            if len(self.live_events_buffer) >= 2:
                self.save_live_session(reason="adb_logcat_exit")
            await asyncio.sleep(2)

    async def ws_handler(self, websocket, path=None):
        # websockets >= 13 passes only the connection; the request path lives on websocket.request.
        if not path:
            request = getattr(websocket, "request", None)
            path = getattr(request, "path", None) or getattr(websocket, "path", None) or "/"
        path = path.split("?", 1)[0]
        if path == "/ingest":
            await self._handle_ingest(websocket)
        else:
            await self.register(websocket)
            try:
                async for message in websocket:
                    try:
                        data = json.loads(message)
                        await self.broadcast(json.dumps(data))
                    except json.JSONDecodeError:
                        print(f"⚠ WS: invalid JSON: {message[:100]}")
                    except Exception as e:
                        print(f"⚠ WS message error: {e}")
            except websockets.exceptions.ConnectionClosed:
                pass
            finally:
                self.clients.discard(websocket)

    async def _handle_ingest(self, websocket):
        """Handle device ingest WebSocket connection with hello/batch/bye protocol."""
        session = None
        counted = False  # True once this connection is counted in ingest_connections
        try:
            async for message in websocket:
                try:
                    data = json.loads(message)
                    msg_type = data.get("type")

                    if msg_type == "hello":
                        # Token validation (optional - if EXOPROFILER_LIVE_TOKEN env var is set)
                        token = data.get("token") or ""
                        expected_token = os.environ.get("EXOPROFILER_LIVE_TOKEN")
                        if expected_token and token != expected_token:
                            await websocket.send(json.dumps({"type": "error", "code": "unauthorized"}))
                            await websocket.close()
                            return

                        # Create or resume a live session
                        session_id = data.get("sessionId") or data.get("session", {}).get("id")
                        schema_version = data.get("schemaVersion", 3)
                        redacted = data.get("redacted", True)
                        device = data.get("device", {})
                        config = data.get("config", {})
                        # For now, accept any token; in production this could be validated
                        session, error = self.live_sessions.create_session(
                            session_id, schema_version, redacted, device, config
                        )
                        if error:
                            await websocket.send(json.dumps({"type": "error", "code": error}))
                            continue
                        await websocket.send(json.dumps({"type": "hello", "status": "ok", "sessionId": session.session_id}))
                        if not counted:
                            # An SDK ingest connection is the source of truth for this device's events.
                            self.ingest_connections = getattr(self, "ingest_connections", 0) + 1
                            counted = True

                    elif msg_type == "batch":
                        if not session:
                            await websocket.send(json.dumps({"type": "error", "code": "no_session"}))
                            continue
                        seq = data.get("seq", 0)
                        events = data.get("events", [])
                        for evt in events:
                            session.add_event(evt)
                            self.live_events_buffer.append(evt)
                        if len(self.live_events_buffer) > 3000:
                            self.live_events_buffer = self.live_events_buffer[-3000:]
                        await websocket.send(json.dumps({"type": "ack", "seq": seq}))
                        await self.broadcast(json.dumps({"type": "events", "sessionId": session.session_id, "events": events}))

                    elif msg_type == "bye":
                        if session:
                            session.finalize()
                        await websocket.send(json.dumps({"type": "bye", "status": "ok"}))
                        break

                    else:
                        await websocket.send(json.dumps({"type": "error", "code": "unknown_message_type"}))

                except json.JSONDecodeError:
                    print(f"⚠ WS ingest: invalid JSON: {message[:100]}")
                except Exception as e:
                    print(f"⚠ WS ingest message error: {e}")
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            # A device that disconnects without sending "bye" must not leave its session marked active.
            if session is not None and session.is_active:
                session.finalize()
            if counted:
                self.ingest_connections = max(0, getattr(self, "ingest_connections", 1) - 1)
            self.clients.discard(websocket)

    def start_http_server(self):
        server = ThreadedHTTPServer((self.host, self.port + 1), UploadHandler)
        server.bridge = self
        thread = threading.Thread(target=server.serve_forever)
        thread.daemon = True
        thread.start()
        return server

    async def run(self):
        self.loop = asyncio.get_event_loop()
        # Bind before starting any work. If another instance owns the ports,
        # say so once and exit cleanly instead of printing a bind traceback.
        try:
            http_server = self.start_http_server()
        except OSError:
            print(f"ExoProfiler is already running on ports {self.port}/{self.port + 1}. Using the running instance.")
            return
        try:
            ws_server = await websockets.serve(self.ws_handler, self.host, self.port)
        except OSError:
            http_server.shutdown()
            print(f"ExoProfiler is already running on ports {self.port}/{self.port + 1}. Using the running instance.")
            return
        asyncio.create_task(self.tail_adb())
        asyncio.create_task(self.periodic_scan())
        try:
            await asyncio.Future()
        finally:
            ws_server.close()

    async def periodic_scan(self):
        while True:
            self.scan_uploaded_files()
            # Retention cleanup: remove stale live sessions
            self.live_sessions.cleanup_stale(max_age_seconds=300)
            await asyncio.sleep(2)

    def scan_uploaded_files(self):
        files = set()
        dirs = [UPLOAD_DIR, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "uploads")]
        for d in dirs:
            if os.path.isdir(d):
                for f in os.listdir(d):
                    if f.endswith(".json"):
                        files.add(f)
        self.uploaded_files = files

def get_adb_devices():
    """Run `adb devices -l` and return [{id, state, model, raw}]. Empty list if adb missing."""
    import subprocess
    adb_bin = _find_adb()
    if not adb_bin:
        return [], False, "adb not installed"
    try:
        out = subprocess.run([adb_bin, "devices", "-l"], capture_output=True, text=True, timeout=3)
    except FileNotFoundError:
        return [], False, "adb not installed"
    except subprocess.TimeoutExpired:
        return [], True, "adb timeout"
    except Exception as e:
        return [], True, str(e)
    lines = (out.stdout or "").strip().splitlines()
    devices = []
    for line in lines[1:]:  # skip "List of devices attached"
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        dev_id, state = parts[0], parts[1]
        model = ""
        for p in parts[2:]:
            if p.startswith("model:"):
                model = p.split("model:", 1)[1]
        devices.append({"id": dev_id, "state": state, "model": model, "raw": line})
    return devices, True, "ok"

def main():
    tags_arg = sys.argv[1] if len(sys.argv) > 1 else ",".join(DEFAULT_TAGS)
    port = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_PORT
    bridge = ExoBridge(tags_arg, port)
    mode_str = "LAN allowed" if bridge.allow_lan else f"local only ({bridge.host})"
    print(f"🚀 ExoPlayer Bridge starting ({mode_str})...")
    print(f"🛠  Filtering for tags: {','.join(bridge.tags)}")
    print(f"   logcat: {' '.join(bridge.logcat_cmd())}")
    print(f"🛠  Press Ctrl+C to stop")
    try:
        asyncio.run(bridge.run())
    except KeyboardInterrupt:
        print("\nStopping bridge...\n")

if __name__ == "__main__":
    main()
