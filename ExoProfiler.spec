# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the ExoProfiler Mac app.

Version is read from ./VERSION so bumping the release is a one-line change.
Build with:  ./build_app.sh
"""
import os

_spec_dir = os.path.dirname(os.path.abspath(SPEC)) if "SPEC" in globals() else os.getcwd()
try:
    with open(os.path.join(_spec_dir, "VERSION")) as _f:
        APP_VERSION = _f.read().strip() or "0.0.0"
except OSError:
    APP_VERSION = "0.0.0"

a = Analysis(
    ["app.py"],
    pathex=[_spec_dir],
    binaries=[],
    datas=[
        ("dashboard", "dashboard"),
        ("assets", "assets"),
        ("bridge", "bridge"),
        ("VERSION", "."),
        ("/Users/vignesh/Library/Android/sdk/platform-tools/adb", "resources/adb"),
    ],
    hiddenimports=["websockets", "webview", "bridge"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="ExoProfiler",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,  # windowed .app: no terminal window on double-click
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="ExoProfiler",
)
app = BUNDLE(
    coll,
    name="ExoProfiler.app",
    icon=os.path.join(_spec_dir, "assets", "ExoProfiler.icns"),
    bundle_identifier="com.exoplayer.profiler",
    info_plist={
        "CFBundleShortVersionString": APP_VERSION,
        "CFBundleVersion": APP_VERSION,
        "CFBundleDisplayName": "ExoProfiler",
        "NSHighResolutionCapable": "True",
    },
)
