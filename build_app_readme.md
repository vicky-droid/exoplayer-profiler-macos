# ExoProfiler Mac App — Build Guide

Double-clickable Mac app + DMG for the team. No Xcode, no terminal, no `pip install` for them.
The app runs in its own window (system WebKit, ~5 MB extra) — no external browser needed.

## What the team gets

- `ExoProfiler-1.0.1.dmg` → drag `ExoProfiler.app` to Applications → double-click.
- Own app window with the dashboard inside (live events, file list, profiler — all as before).
- **Closing the window quits the servers.** Reopen the app to restart. No lingering processes.
- Uploads are saved to `~/Documents/ExoProfiler/uploads/` (survives app updates).
- App icon + tab/favicon logo included.

## Files involved

| File | Purpose |
|------|---------|
| `VERSION` | Single line, e.g. `1.0.1`. Source of truth for the release number. |
| `app.py` | Desktop entry point: starts bridge inside a `pywebview` window. |
| `ExoProfiler.spec` | PyInstaller spec. Reads `VERSION`, bundles `dashboard/` + `assets/`, sets the `.icns`. |
| `build_app.sh` | One-command build: `.app` + `.dmg`. |
| `bridge/bridge.py` | Serves dashboard pages + `/favicon.png` + `/version`, uploads to `~/Documents/...`. |
| `assets/` | `icon-original.png` (source), `icon.png`, `ExoProfiler.icns` (app icon), `favicon.png` (web tab). |

## Prerequisites (maintainer machine only)

```bash
python3 --version        # 3.8+
# build_app.sh auto-installs pyinstaller + pywebview if missing
```

Team members need nothing except the DMG. Optional: `brew install android-platform-tools`
if they want live ADB mode; file/drop mode works without `adb`.

Expected sizes: `.app` ~25–40 MB, `.dmg` similar. (`pywebview` reuses macOS system WebKit,
so it adds only ~5 MB — no bundled Chromium.)

## Release flow (1.0.1 → 1.0.2)

Yes — rebuild the DMG after every change you want the team to have.

```bash
# 1. Make your code changes, test with:
python3 app.py
#    → app window opens with the dashboard inside; close it to quit

# 2. Bump the version (pick one):
echo "1.0.2" > VERSION        # patch fix
# echo "1.1.0" > VERSION      # new feature
# echo "2.0.0" > VERSION      # breaking change

# 3. Build:
./build_app.sh
#    → dist/ExoProfiler.app
#    → ExoProfiler-1.0.2.dmg

# 4. Quick test before sharing:
open "dist/ExoProfiler.app"
#    → window opens, drop a JSON, check ~/Documents/ExoProfiler/uploads/

# 5. Share ExoProfiler-1.0.2.dmg (Slack / Drive / internal link).
```

Keep old DMGs around (`ExoProfiler-1.0.1.dmg`, `-1.0.2.dmg`, …) so anyone can roll back.

Debug tip: `EXOPROFILER_DEBUG=1 python3 app.py` enables right-click → Inspect in the app window.

## Team install instructions (paste to Slack)

1. Open `ExoProfiler-1.0.2.dmg`, drag `ExoProfiler` to Applications.
2. First launch: right-click `ExoProfiler` → Open → Open (unsigned app, one-time only).
3. Dashboard opens inside the app window. Done.
4. Files land in `Documents/ExoProfiler/uploads/`.
5. Quit by closing the window — reopen to start fresh.

## Replacing the logo later

Drop the new square PNG over `assets/icon-original.png`, then regenerate:

```bash
sips -Z 1024 assets/icon-original.png --out assets/icon.png
rm -rf /tmp/ExoProfiler.iconset && mkdir -p /tmp/ExoProfiler.iconset
for s in 16 32 64 128 256 512; do
  sips -Z $s assets/icon.png --out /tmp/ExoProfiler.iconset/icon_${s}x${s}.png >/dev/null
  d=$((s*2)); sips -Z $d assets/icon.png --out /tmp/ExoProfiler.iconset/icon_${s}x${s}@2x.png >/dev/null
done
sips -Z 1024 assets/icon.png --out /tmp/ExoProfiler.iconset/icon_512x512@2x.png >/dev/null
iconutil -c icns /tmp/ExoProfiler.iconset -o assets/ExoProfiler.icns
sips -Z 64 assets/icon.png --out assets/favicon.png
```

Then bump `VERSION` and run `./build_app.sh` — the web favicon updates with no HTML edits.

## Where uploads go

- **Packaged app and dev runs:** `~/Documents/ExoProfiler/uploads/`
  (`upload_<timestamp>.json` per `POST /upload`).
- First run auto-copies any old `exoplayer-profiler-v4/uploads/*.json` there, so nothing is lost.
- Override if needed: `EXOPROFILER_UPLOAD_DIR=/tmp/x python3 app.py` (handy for tests).

## Ports

| Port | What |
|------|------|
| `9090` | WebSocket live ADB feed |
| `9091` | HTTP: dashboard `/`, `/favicon.png`, `/version`, `/status`, `/upload`, `/uploaded-files`, `/uploads/*` |

Phones on the same Wi-Fi still reach the app via the LAN URL shown on launch
(`http://<lan-ip>:9091/upload`), same as before.

## Troubleshooting

- **"Unverified developer" on first open:** right-click → Open → Open. (Disappears only
  with a paid Apple Developer signature — not needed internally.)
- **Port already in use:** just close the app window (that quits the server). If stuck:
  `pkill -f ExoProfiler; pkill -f bridge.py`, then relaunch.
- **Live feed empty but files work:** `adb` missing or no device —
  `brew install android-platform-tools`, then `adb devices`.
- **Dashboard file not found:** rebuild — `dashboard/` is bundled at build time,
  so HTML edits need a fresh `./build_app.sh`.
- **PyInstaller fails:** `pip3 install --upgrade pyinstaller`, delete `build/ dist/`, retry.
- **`pip install pywebview` fails to build pyobjc (linker/tapi errors):** this machine's
  Xcode command-line SDKs are broken for source builds. Use prebuilt wheels instead:
  `pip3 install "pyobjc==10.3.1"` then `pip3 install --no-deps "pywebview==4.4.1"`
  plus `pip3 install bottle proxy_tools "pyobjc-framework-UniformTypeIdentifiers==10.3.1"`.
