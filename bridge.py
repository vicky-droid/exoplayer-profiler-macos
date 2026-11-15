"""Compatibility shim so running `python3 bridge.py` works seamlessly."""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from bridge.bridge import (
    DEFAULT_PORT,
    DEFAULT_HOST,
    DEFAULT_TAGS,
    DEFAULT_TAG,
    APP_VERSION,
    ExoBridge,
    get_local_ip,
    get_adb_devices,
    main,
)

if __name__ == "__main__":
    main()
