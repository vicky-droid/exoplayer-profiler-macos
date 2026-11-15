"""ExoProfiler desktop entry point (PyInstaller .app + dev).

Runs inside its own window (system WebKit, no external browser).
Closing the window stops the servers — reopen the app to restart.
"""
import asyncio
import fcntl
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

# Allow running as `python app.py` from repo root and as frozen PyInstaller app.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from bridge.bridge import (
    DEFAULT_PORT,
    DEFAULT_HOST,
    DEFAULT_TAGS,
    APP_VERSION,
    ExoBridge,
    get_local_ip,
    get_adb_devices,
)

try:
    import webview
except ImportError:
    webview = None

_LOCK_FD = None


def acquire_instance_lock():
    """Ensure single instance of ExoProfiler is running."""
    global _LOCK_FD
    lock_path = os.path.join(tempfile.gettempdir(), "exoplayer_profiler.lock")
    try:
        _LOCK_FD = open(lock_path, "w")
        fcntl.flock(_LOCK_FD, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except (IOError, OSError):
        return False


def _dashboard_url(port: int) -> str:
    return f"http://localhost:{port + 1}/"


def _run_bridge(bridge: ExoBridge) -> None:
    try:
        asyncio.run(bridge.run())
    except RuntimeError:
        pass  # loop closed during shutdown


def _wait_for_server(http_port: int, timeout: float = 15.0) -> bool:
    url = f"http://localhost:{http_port}/version"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.2)
    return False


def main() -> None:
    if not acquire_instance_lock():
        try:
            subprocess.run([
                "osascript", "-e",
                'tell application "System Events" to set frontmost of (first process whose name contains "ExoProfiler" or name contains "Python") to true'
            ], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass
        print("ExoProfiler is already running. Existing window brought to focus.")
        sys.exit(0)

    tags_arg = sys.argv[1] if len(sys.argv) > 1 else ",".join(DEFAULT_TAGS)
    try:
        port = int(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_PORT
    except ValueError:
        port = DEFAULT_PORT

    bridge = ExoBridge(tags_arg, port)
    url = _dashboard_url(port)
    devices, adb_ok, msg = get_adb_devices()
    print(f"ExoProfiler v{APP_VERSION} started")
    if devices:
        dev_list = ", ".join(f"{d['id']} ({d.get('model') or d.get('state')})" for d in devices)
        print(f"Connected devices: {dev_list}")

    if webview is None:
        # Dev machine without the optional dep — browser fallback so work isn't blocked.
        print("pywebview not installed (pip3 install pywebview). Opening in browser instead.")
        import webbrowser

        webbrowser.open(url)
        try:
            asyncio.run(bridge.run())
        except KeyboardInterrupt:
            print("\nStopping ExoProfiler...")
        return

    thread = threading.Thread(target=_run_bridge, args=(bridge,), daemon=True)
    thread.start()
    if not _wait_for_server(port + 1):
        print("WARNING: server did not answer in time — window may show an error.")

    debug = os.environ.get("EXOPROFILER_DEBUG", "1") == "1"
    # Use bundled icns when frozen; fall back to repo assets when dev.
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        icon = os.path.join(sys._MEIPASS, "assets", "ExoProfiler.icns")
    else:
        icon = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "ExoProfiler.icns")
    webview.create_window(f"ExoProfiler v{APP_VERSION}", url, width=1280, height=860)
    webview.start(debug=debug)
    # Window closed → terminate everything so reopen = fresh restart, ports freed.
    os._exit(0)


if __name__ == "__main__":
    main()
