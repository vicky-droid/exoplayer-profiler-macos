"""ffprobe action (plan V7). Desktop only, raw live sessions only.

Security rules (from PYTHON_APP_PLAN section 6):
- Only chunks that exist in the in-memory raw session are probed; request-supplied
  URLs are never used (no server-side request forgery).
- Refuses redacted sessions and chunks without a raw URI.
- http/https only; redirects to other schemes are refused; no cookies.
- Size caps per chunk and per request; timeouts for download and ffprobe.
- ffprobe runs through subprocess with an argument list (never a shell).
- Temp files live in a per-request directory removed in a ``finally``.
- Errors never echo a full URL (signed query tokens must not leak into logs or UI).
"""

import json
import os
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request

MAX_CHUNK_BYTES = 50 * 1024 * 1024
MAX_TOTAL_BYTES = 200 * 1024 * 1024
MAX_CHUNKS_PER_REQUEST = 8
DOWNLOAD_TIMEOUT_S = 30
FFPROBE_TIMEOUT_S = 20
MAX_FFPROBE_OUTPUT_CHARS = 200_000
ENCRYPTED_MARKERS = (b"encv", b"enca", b"tenc")
COMMON_FFPROBE_PATHS = ("/opt/homebrew/bin/ffprobe", "/usr/local/bin/ffprobe")
REDACTED_MESSAGE = (
    "Raw URLs are removed from redacted sessions. Capture the session on a debug "
    "device with raw live streaming."
)


class ProbeError(Exception):
    """A user-facing probe failure. The message never contains a full URL."""


def find_ffprobe(env=None, which=shutil.which, common_paths=COMMON_FFPROBE_PATHS, isfile=os.path.isfile):
    """Resolve ffprobe: FFPROBE env var, then PATH, then common macOS locations. No auto-install."""
    env = os.environ if env is None else env
    explicit = env.get("FFPROBE")
    if explicit:
        return explicit if isfile(explicit) and os.access(explicit, os.X_OK) else None
    found = which("ffprobe")
    if found:
        return found
    for candidate in common_paths:
        if isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def is_allowed_url(url):
    """True only for absolute http or https URLs with a host."""
    if not isinstance(url, str) or not url:
        return False
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return False
    return parsed.scheme in ("http", "https") and bool(parsed.hostname)


def _safe_host(url):
    try:
        return urllib.parse.urlparse(url).hostname or "unknown-host"
    except ValueError:
        return "unknown-host"


def _chunk_details(session_events):
    """Map chunkId -> latest chunk details for CHUNK events that carry a chunkId."""
    by_id = {}
    for event in session_events:
        if not isinstance(event, dict):
            continue
        if event.get("category", event.get("cat")) != "CHUNK":
            continue
        details = event.get("details") or {}
        chunk_id = details.get("chunkId")
        if chunk_id is None:
            continue
        by_id[int(chunk_id)] = details
    return by_id


def select_chunks(session_events, chunk_ids, redacted=False):
    """Return the probe inputs for ``chunk_ids`` taken only from the session.

    Raises ProbeError for redacted sessions, unknown chunk ids, chunks without a
    raw URI, non-http URIs, and requests above the chunk-count limit.
    """
    if redacted:
        raise ProbeError(REDACTED_MESSAGE)
    if not chunk_ids:
        raise ProbeError("No chunks selected.")
    if len(chunk_ids) > MAX_CHUNKS_PER_REQUEST:
        raise ProbeError(f"At most {MAX_CHUNKS_PER_REQUEST} chunks per request.")
    details_by_id = _chunk_details(session_events)
    selected = []
    for raw_id in chunk_ids:
        try:
            chunk_id = int(raw_id)
        except (TypeError, ValueError):
            raise ProbeError("Chunk ids must be integers.")
        details = details_by_id.get(chunk_id)
        if details is None:
            raise ProbeError(f"Chunk {chunk_id} is not part of this session.")
        raw_uri = details.get("uriRaw")
        if not raw_uri:
            raise ProbeError(REDACTED_MESSAGE)
        if not is_allowed_url(raw_uri):
            raise ProbeError(f"Chunk {chunk_id} has a URL scheme that cannot be probed.")
        selected.append({
            "chunkId": chunk_id,
            "uriRaw": raw_uri,
            "dataType": details.get("dataType"),
            "trackFormatId": details.get("trackFormatId"),
            "byteStart": int(details.get("byteStart") or 0),
            "byteLength": int(details.get("byteLength") if details.get("byteLength") is not None else -1),
        })
    return selected


def find_init_chunk(session_events, track_format_id):
    """Latest INIT chunk with the same track format id (for fMP4 media chunks)."""
    if track_format_id is None:
        return None
    found = None
    for details in _chunk_details(session_events).values():
        if details.get("dataType") == "INIT" and details.get("trackFormatId") == track_format_id and details.get("uriRaw"):
            if found is None or details.get("chunkId", 0) > found.get("chunkId", 0):
                found = details
    if found is None:
        return None
    return {
        "chunkId": int(found["chunkId"]),
        "uriRaw": found["uriRaw"],
        "dataType": "INIT",
        "trackFormatId": found.get("trackFormatId"),
        "byteStart": int(found.get("byteStart") or 0),
        "byteLength": int(found.get("byteLength") if found.get("byteLength") is not None else -1),
    }


class _HttpOnlyRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not is_allowed_url(newurl):
            raise ProbeError("A redirect to a non-http URL was refused.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def build_opener():
    """urllib opener with no cookie jar and http/https-only redirects."""
    return urllib.request.build_opener(_HttpOnlyRedirectHandler)


def _range_header(byte_start, byte_length):
    if byte_length is not None and byte_length >= 0:
        return f"bytes={byte_start}-{byte_start + byte_length - 1}"
    if byte_start > 0:
        return f"bytes={byte_start}-"
    return None


def download_range(url, byte_start, byte_length, dest_path, opener, *,
                   timeout=DOWNLOAD_TIMEOUT_S, max_bytes=MAX_CHUNK_BYTES):
    """Download one chunk (or byte range) to ``dest_path``. Returns bytes written."""
    if byte_length is not None and byte_length > max_bytes:
        raise ProbeError("Chunk is larger than the per-chunk size cap.")
    headers = {}
    range_value = _range_header(byte_start, byte_length)
    if range_value:
        headers["Range"] = range_value
    request = urllib.request.Request(url, headers=headers)
    total = 0
    try:
        with opener.open(request, timeout=timeout) as response, open(dest_path, "wb") as out:
            while True:
                block = response.read(64 * 1024)
                if not block:
                    break
                total += len(block)
                if total > max_bytes:
                    raise ProbeError("Download exceeded the per-chunk size cap.")
                out.write(block)
    except urllib.error.HTTPError as e:
        raise ProbeError(f"Download from {_safe_host(url)} failed with HTTP {e.code}.")
    except urllib.error.URLError as e:
        reason = getattr(e, "reason", e)
        raise ProbeError(f"Download from {_safe_host(url)} failed: {type(reason).__name__}.")
    except OSError as e:
        raise ProbeError(f"Download from {_safe_host(url)} failed: {type(e).__name__}.")
    return total


def run_ffprobe(ffprobe_path, file_path, *, timeout=FFPROBE_TIMEOUT_S, max_output=MAX_FFPROBE_OUTPUT_CHARS):
    """Run ffprobe on a local file and return the parsed JSON. Argument list only, no shell."""
    args = [
        ffprobe_path, "-v", "error", "-show_format", "-show_streams",
        "-print_format", "json", file_path,
    ]
    try:
        proc = subprocess.run(args, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise ProbeError("ffprobe timed out.")
    except OSError as e:
        raise ProbeError(f"ffprobe could not be started: {type(e).__name__}.")
    if proc.returncode != 0:
        summary = proc.stderr.decode("utf-8", "replace").strip().splitlines()[:1]
        raise ProbeError("ffprobe failed: " + (summary[0][:200] if summary else f"exit {proc.returncode}"))
    text = proc.stdout[:max_output].decode("utf-8", "replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        raise ProbeError("ffprobe output was not valid JSON.")


def has_encryption_markers(file_path, limit=1024 * 1024):
    """True when the container head contains common CENC/encrypted sample entry boxes."""
    try:
        with open(file_path, "rb") as f:
            head = f.read(limit)
    except OSError:
        return False
    return any(marker in head for marker in ENCRYPTED_MARKERS)


def probe_chunks(chunks, session_events, *, ffprobe_path, opener=None, tmp_root=None,
                 max_total_bytes=MAX_TOTAL_BYTES):
    """Probe the selected chunks. One result per chunk; a failing chunk never aborts the others.

    Media chunks of fMP4 tracks are probed as init + media concatenated, so the
    result reflects a playable file. Temp files are removed before returning.
    """
    if not ffprobe_path:
        raise ProbeError("ffprobe was not found. Install it (for example `brew install ffmpeg`) or set FFPROBE.")
    opener = opener or build_opener()
    tmp_dir = tempfile.mkdtemp(prefix="exoprobe-", dir=tmp_root)
    results = []
    total_bytes = 0
    try:
        for chunk in chunks:
            result = {"chunkId": chunk["chunkId"], "ok": False}
            try:
                parts = []
                init = None
                if chunk.get("dataType") == "MEDIA":
                    init = find_init_chunk(session_events, chunk.get("trackFormatId"))
                for index, part in enumerate(([init] if init else []) + [chunk]):
                    dest = os.path.join(tmp_dir, f"chunk{chunk['chunkId']}_{index}.bin")
                    remaining = max_total_bytes - total_bytes
                    if remaining <= 0:
                        raise ProbeError("Request exceeded the total download cap.")
                    written = download_range(
                        part["uriRaw"], part["byteStart"], part["byteLength"], dest, opener,
                        max_bytes=min(MAX_CHUNK_BYTES, remaining),
                    )
                    total_bytes += written
                    parts.append(dest)
                target = os.path.join(tmp_dir, f"probe{chunk['chunkId']}.bin")
                with open(target, "wb") as out:
                    for part_path in parts:
                        with open(part_path, "rb") as src:
                            shutil.copyfileobj(src, out)
                        os.remove(part_path)
                encrypted = has_encryption_markers(target)
                data = run_ffprobe(ffprobe_path, target)
                result.update({
                    "ok": True,
                    "encrypted": encrypted,
                    "format": data.get("format", {}),
                    "streams": data.get("streams", []),
                    "note": "encrypted: stream details unavailable" if encrypted else None,
                })
            except ProbeError as e:
                result["error"] = str(e)
            results.append(result)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
    return results
