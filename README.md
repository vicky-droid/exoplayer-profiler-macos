# ExoPlayer Profiler v4 - Desktop Viewer

## Overview

This project provides a local HTTP + WebSocket server (bridge) that receives profiler events from Android apps, saves them as JSON sessions, and serves a dashboard for analysis. The dashboard can open uploaded sessions in the ExoPlayer Profiler v4 visualization.

## Architecture

```
Android App
   ↓ POST JSON / WebSocket events
Local HTTP + WebSocket Server (ports 9091 / 9090)
   ↓ Save JSON / broadcast events
./uploads/ folder
   ↓ GET /uploaded-files
Dashboard (port 9091 UI)
    ↓ List files
    ↓ Click file → open profiler
```

## Ports

| Port | Service | Description |
|------|---------|-------------|
| **9090** | WebSocket Server | ExoPlayer Bridge - tails ADB logcat and broadcasts events via WebSocket |
| **9091** | HTTP Server | JSON Upload Endpoint - receives POST /upload and serves /uploaded-files |

## Quick Start

### 1. Install dependencies

```bash
pip3 install websockets
```

### 2. Start the bridge server

```bash
python3 bridge/bridge.py
```

The server will start both services:
- `ws://localhost:9090` - WebSocket for live debugging
- `http://localhost:9091/` - HTTP for JSON file uploads and dashboard

### 3. Upload JSON from Android

Use `curl` or your Android HTTP client:

```bash
curl -X POST http://localhost:9091/upload \
  -H "Content-Type: application/json" \
  -d '{"event":"TestEvent","details":{"playbackState":2}}'
```

Or via Android's OkHttp/Retrofit to `http://<local-ip>:9091/upload`.

### 4. View uploaded files

Open your browser and navigate to the dashboard:

```
open dashboard/index.html
```

The dashboard will automatically:
- Fetch `/net-info` to get WS/HTTP URLs
- Connect to the WebSocket server
- Fetch the list of uploaded files from `/uploaded-files`
- Display clickable file names

### 5. Open a profiler session

Click any file in the list. The profiler page (`exoplayer_profiler_v4.html`) will load with the session data.

---

## Stopping the Server

### Method 1: Ctrl+C

If running in the foreground, press `Ctrl+C` to stop gracefully.

### Method 2: Kill the process

```bash
# Find the process
ps aux | grep bridge.py

# Kill it
kill <PID>
# Or
pkill -f "bridge.py"
```

### Method 3: Clean restart

```bash
# Stop any running instance
pkill -f "bridge.py" 2>/dev/null
sleep 1

# Remove old uploads (optional)
rm -rf uploads/

# Start fresh
python3 bridge/bridge.py
```

## Troubleshooting

### "404 File not found" errors

This usually means:

1. **Wrong port**: You're hitting port 9090 for uploads, but uploads are on port 9091
   - WebSocket/events → port 9090
   - JSON uploads → port 9091

2. **Server not running**: Start the bridge with `python3 bridge/bridge.py`

3. **POST method not supported**: Ensure you're using `curl -X POST` or Android's HTTP POST method

4. **Content-Type missing**: Include `Content-Type: application/json` header

### Checking if server is running

```bash
# Test HTTP endpoint
curl http://localhost:9091/uploaded-files

# Test upload endpoint
curl -X POST http://localhost:9091/upload -H "Content-Type: application/json" -d '{"test":"data"}'

# Test net-info endpoint
curl http://localhost:9091/net-info
```

### Common issues

- **ModuleNotFoundError: websockets**: Run `pip3 install websockets`
- **Port already in use**: Kill existing processes with `pkill -f "bridge.py"` or change the port in `bridge.py`
- **Android can't connect**: Use your machine's local IP (e.g., `192.168.1.15`) instead of `localhost`, and ensure firewall allows port 9091

## File Structure

```
exoplayer-profiler-v4/
├── bridge/
│   └── bridge.py          # Main server - HTTP + WebSocket
├── dashboard/
│   ├── index.html         # Dashboard launcher / session list
│   └── exoplayer_profiler_v4.html  # Profiler visualization
├── archive/               # Archived/deprecated files
│   ├── script_profiler.js
│   └── script_index.js
├── uploads/               # Auto-created directory for stored JSON files
├── app.py                 # pywebview desktop launcher
├── ExoProfiler.spec       # PyInstaller spec
├── build_app.sh           # Build script
└── README.md              # This file
```

## Android App Configuration

Configure your Android app to send profiler events to:

- **Live (WebSocket)**: `ws://<your-mac-ip>:9090`
- **Upload (HTTP)**: `http://<your-mac-ip>:9091/upload`

Use `adb reverse tcp:9090 tcp:9090` and `adb reverse tcp:9091 tcp:9091` for wireless debugging without USB.

## Version

See `VERSION` file.