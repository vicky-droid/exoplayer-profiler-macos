
        // ── UI ELEMENTS ──
        const dropzone = document.getElementById('dropzone');
        const btnOpenModal = document.getElementById('btn-open-modal');
        const btnCloseModal = document.getElementById('btn-close-modal');
        const modalOverlay = document.getElementById('modal-overlay');
        const btnCopy = document.getElementById('btn-copy');
        const cmdText = document.getElementById('cmd-text');
        const indicator = document.getElementById('indicator');
        const connText = document.getElementById('conn-text');
        const filesList = document.getElementById('files-list');
        const livePanel = document.getElementById('live-panel');
        const liveStatus = document.getElementById('live-status');
        const liveEvents = document.getElementById('live-events');

        // ── MODAL LOGIC ──
        btnOpenModal.onclick = () => modalOverlay.style.display = 'flex';
        btnCloseModal.onclick = () => modalOverlay.style.display = 'none';
        
        // Close on overlay click
        modalOverlay.onclick = (e) => {
            if (e.target === modalOverlay) modalOverlay.style.display = 'none';
        };

        btnCopy.onclick = async () => {
            const text = cmdText.innerText;
            try {
                await navigator.clipboard.writeText(text);
                const originalText = btnCopy.innerText;
                btnCopy.innerText = '✅ Copied!';
                btnCopy.style.background = 'var(--green)';
                setTimeout(() => {
                    btnCopy.innerText = originalText;
                    btnCopy.style.background = 'var(--accent)';
                }, 2000);
            } catch (err) {
                console.error('Failed to copy: ', err);
            }
        };

        // ── FILE DROP LOGIC ──
        function openProfilerWithData(data, live) {
            // Save live session data to localStorage for persistence across nav
            try {
                if (live) {
                    localStorage.setItem('exo_live_session', typeof data === 'string' ? data : JSON.stringify(data));
                }
            } catch (err) {
                console.error('localStorage full:', err);
            }
            try {
                sessionStorage.setItem('exo_pending_session', typeof data === 'string' ? data : JSON.stringify(data));
            } catch (err) {
                console.error('sessionStorage full:', err);
            }
            window.location.href = 'exoplayer_profiler_v4.html?from=dashboard' + (live ? '&live=1' : '');
        }

        function handleLocalFile(file) {
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const data = JSON.parse(ev.target.result);
                    console.log("Loaded session:", data);
                    openProfilerWithData(ev.target.result);
                } catch (err) {
                    alert('Failed to parse JSON: ' + err.message);
                }
            };
            reader.readAsText(file);
        }

        // Click-to-select (dropzone text promises "or click to select")
        const filePicker = document.createElement('input');
        filePicker.type = 'file';
        filePicker.accept = '.json,application/json';
        filePicker.style.display = 'none';
        filePicker.onchange = () => { if (filePicker.files[0]) handleLocalFile(filePicker.files[0]); filePicker.value = ''; };
        document.body.appendChild(filePicker);
        dropzone.onclick = () => filePicker.click();

        dropzone.ondragover = (e) => { e.preventDefault(); dropzone.classList.add('drag'); };
        dropzone.ondragleave = () => { dropzone.classList.remove('drag'); };
        dropzone.ondrop = (e) => {
            e.preventDefault();
            dropzone.classList.remove('drag');
            const file = e.dataTransfer.files[0];
            if (file) handleLocalFile(file);
        };

        // ── LIVE WEBSOCKET EVENTS + ADB DEVICES ──
        let livePaused = false;
        let liveCount = 0;
        const LIVE_STORAGE_KEY = "exo_live_session";
        let liveBuffer = [];
        let liveWs = null;
        const pillDevices = document.getElementById('pill-devices');
        const pillTag = document.getElementById('pill-tag');
        const pillCount = document.getElementById('pill-count');
        const liveStatusText = document.getElementById('live-status-text');
        const adbDevicesEl = document.getElementById('adb-devices');
        const liveFilterEl = document.getElementById('live-filter');
        // Removed tag filter elements
        const btnPause = document.getElementById('btn-pause');
        const btnClear = document.getElementById('btn-clear');
        const btnDevices = document.getElementById('btn-devices');
        const btnSaveSession = document.getElementById('btn-save-session');
        const btnLiveProfiler = document.getElementById('btn-live-profiler');


        btnPause.onclick = () => {
            livePaused = !livePaused;
            btnPause.innerText = livePaused ? '▶ Resume' : '⏸ Pause';
            btnPause.classList.toggle('on', livePaused);
        };
        btnClear.onclick = () => {
            liveEvents.innerHTML = '';
            liveCount = 0;
            liveBuffer = [];
            pillCount.innerHTML = '<b>0</b> events';
            try { localStorage.removeItem(LIVE_STORAGE_KEY); } catch (e) {}
        };
        btnDevices.onclick = () => loadAdbDevices();
        btnSaveSession.onclick = saveCurrentSession;
        btnLiveProfiler.onclick = () => openLiveInProfiler();

        liveFilterEl.oninput = () => {
            const q = liveFilterEl.value.trim().toLowerCase();
            const terms = q ? q.split(',').map(t => t.trim()).filter(Boolean) : [];
            [...liveEvents.children].forEach(el => {
                if (!el.classList.contains('evt')) return;
                if (!terms.length) {
                    el.style.display = '';
                } else {
                    const search = (el.dataset.search || '').toLowerCase();
                    el.style.display = terms.some(term => search.includes(term)) ? '' : 'none';
                }
            });
        };

        // Removed tag filter logic

        let netInfo = { local_ip: null, ws_url: 'ws://localhost:9090', http_url: 'http://localhost:9091' };
        const netText = document.getElementById('net-text');
        const btnCopyIp = document.getElementById('btn-copy-ip');
        if (btnCopyIp) btnCopyIp.onclick = async () => {
            try { await navigator.clipboard.writeText(netInfo.http_url + '/upload'); btnCopyIp.innerText = '✅ Copied!'; setTimeout(() => btnCopyIp.innerText = 'Copy', 2000); }
            catch (e) { console.error(e); }
        };

        function setLiveStatus(connected, text) {
            liveStatus.className = 'live-status ' + (connected ? 'connected' : 'disconnected');
            const wsLabel = netInfo.local_ip ? `${netInfo.ws_url} (localhost:9090)` : 'ws://localhost:9090';
            liveStatusText.innerText = (connected ? `Connected to ${wsLabel}` : 'Disconnected') + (text ? ` — ${text}` : '');
            if (connected) { indicator.classList.add('live-on'); connText.innerText = `🟢 Connected to ${wsLabel}`; }
            else { indicator.classList.remove('live-on'); connText.innerText = '🔴 Disconnected (Post-mortem mode)'; }
        }

        async function loadAdbDevices() {
            try {
                console.log('[ADB] loadAdbDevices: fetching /adb-devices');
                const resp = await fetch('/adb-devices');
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const data = await resp.json();
                console.log('[ADB] loadAdbDevices: response received', JSON.stringify(data));
                console.log('[ADB DEVICES IN UI] Count:', data.devices ? data.devices.length : 0, 'Devices:', data.devices);
                const tags = data.tags || [data.tag || 'PlaybackProfiler'];
                pillTag.innerText = 'tags: ' + tags.join(', ');
                pillTag.title = 'adb logcat -s ' + tags.map(t => t + ':*').join(' ');
                if (data.local_ip) {
                    netInfo = { local_ip: data.local_ip, ws_url: data.ws_url, http_url: data.http_url };
                    netText.textContent = `LAN ${data.local_ip} · WS ${data.ws_url} · Upload ${data.http_url}/upload`;
                    // refresh status line with IP if already connected
                    if (liveStatus.classList.contains('connected')) setLiveStatus(true, 'tailing filtered tag');
                }
                renderDevices(data.devices || [], data.adb_available, data.message);
            } catch (err) {
                console.error('[ADB] loadAdbDevices error:', err);
                netText.textContent = 'bridge offline — start bridge.py to resolve LAN IP';
                renderDevices([], false, err.message);
            }
        }

        function renderDevices(devices, adbOk, msg) {
            console.log('[RENDER] renderDevices: devices.length =', devices.length, 'adbOk =', adbOk, 'msg =', msg);
            // Always show device count in pill
            pillDevices.innerHTML = `📱 <b>${devices.length}</b> device${devices.length === 1 ? '' : 's'}`;
            pillDevices.className = 'pill ' + (devices.length > 0 ? 'ok' : 'bad');
            
            // Show adb status in pill title (but don't prevent device rendering)
            if (adbOk) {
                pillDevices.title = 'adb available';
            } else {
                pillDevices.title = 'adb ' + (msg || 'unknown');
            }
            
            // Render device list if we have devices
            adbDevicesEl.innerHTML = '';
            if (devices.length === 0) {
                adbDevicesEl.innerHTML = `<div class="dev none">No devices — connect via <code>adb connect &lt;ip&gt;</code> or USB, then ↻ Devices.</div>`;
                return;
            }
            devices.forEach((d, i) => {
                console.log('[RENDER]   device', i, ':', JSON.stringify(d));
                const online = d.state === 'device';
                const div = document.createElement('div');
                div.className = 'dev ' + (online ? 'online' : 'offline');
                div.innerHTML = `<span class="dev-dot"></span><span class="dev-id">${d.id}</span><span class="dev-meta">${d.model ? '· ' + d.model + ' ' : ''}· ${d.state}</span>`;
                adbDevicesEl.appendChild(div);
            });
            console.log('[RENDER] renderDevices: done rendering', devices.length, 'devices');
        }

        function liveEventsToSession(evts) {
            // Convert bridge WS payloads {event, category, rel(s), ts(s), tag, details}
            // into profiler session format {schemaVersion, session, events:[{timeMs, timestampMs, category, event, thread, details}]}
            const sorted = [...evts].sort((a, b) => (a.ts || 0) - (b.ts || 0) || (a.rel || 0) - (b.rel || 0));
            const events = sorted.map(e => ({
                timeMs: Math.round((e.rel ?? 0) * 1000),
                timestampMs: Math.round((e.ts ?? Date.now() / 1000) * 1000),
                category: e.category || 'Live',
                event: e.event || 'Log',
                thread: e.tag || 'live',
                details: (e.details && typeof e.details === 'object') ? e.details : {}
            }));
            // Rebase so session starts at 0 like exported files (profiler uses rel=timeMs)
            if (events.length) {
                const t0 = events[0].timeMs;
                events.forEach(e => { e.timeMs = Math.max(0, e.timeMs - t0); });
            }
            const last = events.length ? events[events.length - 1].timeMs : 0;
            const firstTs = sorted.length ? Math.round(sorted[0].ts * 1000) : Date.now();
            return {
                schemaVersion: 1,
                session: {
                    id: 'live-' + new Date().toISOString().replace(/[:.]/g, '-'),
                    packageName: 'live-adb',
                    startedAtEpochMs: firstTs,
                    exportedAtEpochMs: Date.now(),
                    durationMs: Math.max(1000, last + 500),
                    eventCount: events.length
                },
                events
            };
        }

        function openLiveInProfiler() {
            if (!liveBuffer.length) { alert('No live events buffered yet — play video, then try again.'); return; }
            openProfilerWithData(JSON.stringify(liveEventsToSession(liveBuffer)), true);
        }

        function addLiveEvent(data) {
            // Always buffer (even when paused) so Open-in-profiler gets full session
            liveBuffer.push(data);
            // Keep buffer bounded to avoid storage overflow
            if (liveBuffer.length > 1000) liveBuffer = liveBuffer.slice(-1000);
            if (livePaused) return;
            const empty = liveEvents.querySelector('.empty');
            if (empty) empty.remove();
            liveCount++;
            pillCount.innerHTML = `<b>${liveCount}</b> event${liveCount === 1 ? '' : 's'}`;
            const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
            const detailsVal = data.details && typeof data.details === 'object' ? data.details : {};
            const detailsStr = Object.entries(detailsVal).slice(0, 3).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
            const label = (data.category ? `[${data.category}] ` : '') + (data.event || 'Unknown');
            const evtLine = document.createElement('div');
            evtLine.className = 'evt';
            evtLine.dataset.search = `${label.toLowerCase()} ${detailsStr.toLowerCase()} ${(data.raw || '').toLowerCase()} ${(data.tag || '').toLowerCase()}`;
            evtLine.title = data.raw || JSON.stringify(data, null, 2);
            const evtName = document.createElement('span'); evtName.className = 't'; evtName.textContent = label;
            const evtTime = document.createElement('span'); evtTime.className = 'time'; evtTime.textContent = `${time} · ${data.rel ?? 0}s`;
            const evtDet = document.createElement('span'); evtDet.className = 'd'; evtDet.textContent = detailsStr || (data.raw || '');
            evtLine.append(evtTime, evtName, evtDet);
            liveEvents.insertBefore(evtLine, liveEvents.firstChild);
            while (liveEvents.querySelectorAll('.evt').length > 50) liveEvents.removeChild(liveEvents.lastChild);
            liveFilterEl.oninput();
        }

        // ── SAVED SESSIONS (localStorage) ──
        const SAVED_SESSIONS_KEY = "exo_saved_sessions";

        function restoreSavedSession() {
            try {
                const raw = localStorage.getItem(LIVE_STORAGE_KEY);
                if (!raw) return;
                const saved = JSON.parse(raw);
                if (!Array.isArray(saved) || saved.length === 0) return;
                liveBuffer = saved.slice();
                if (liveBuffer.length > 1000) liveBuffer = liveBuffer.slice(-1000);
                liveCount = liveBuffer.length;
                pillCount.innerHTML = `<b>${liveCount}</b> event${liveCount === 1 ? '' : 's'}`;
                const empty = liveEvents.querySelector('.empty');
                if (empty) empty.remove();
                // Render newest first (matching addLiveEvent insertBefore behavior)
                const toShow = liveBuffer.slice(-50).reverse();
                toShow.forEach(data => {
                    const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
                    const detailsVal = data.details && typeof data.details === 'object' ? data.details : {};
                    const detailsStr = Object.entries(detailsVal).slice(0, 3).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
                    const label = (data.category ? `[${data.category}] ` : '') + (data.event || 'Unknown');
                    const evtLine = document.createElement('div');
                    evtLine.className = 'evt';
                    evtLine.dataset.search = `${label.toLowerCase()} ${detailsStr.toLowerCase()} ${(data.raw || '').toLowerCase()} ${(data.tag || '').toLowerCase()}`;
                    evtLine.title = data.raw || JSON.stringify(data, null, 2);
                    const evtName = document.createElement('span'); evtName.className = 't'; evtName.textContent = label;
                    const evtTime = document.createElement('span'); evtTime.className = 'time'; evtTime.textContent = `${time} · ${data.rel ?? 0}s`;
                    const evtDet = document.createElement('span'); evtDet.className = 'd'; evtDet.textContent = detailsStr || (data.raw || '');
                    evtLine.append(evtTime, evtName, evtDet);
                    liveEvents.insertBefore(evtLine, liveEvents.firstChild);
                });
                liveFilterEl.oninput();
                console.log('[RESTORE] Restored', liveBuffer.length, 'saved live events from localStorage');
            } catch (e) {
                console.error('Failed to restore saved session:', e);
            }
        }

        function getSavedSessions() {
            try {
                const raw = localStorage.getItem(SAVED_SESSIONS_KEY);
                return raw ? JSON.parse(raw) : [];
            } catch (e) { return []; }
        }

        function saveSavedSessions(list) {
            try {
                localStorage.setItem(SAVED_SESSIONS_KEY, JSON.stringify(list));
                renderSavedSessions();
            } catch (e) { console.error('Failed to save session list:', e); }
        }

        function renderSavedSessions() {
            const container = document.getElementById('saved-sessions-list');
            if (!container) return;
            const list = getSavedSessions();
            container.innerHTML = '';
            if (list.length === 0) {
                container.innerHTML = '<div style="color: var(--muted); font-size: 0.75rem; padding: 10px;">No saved sessions yet. Click "Save Session" to store the current live buffer.</div>';
                return;
            }
            const ul = document.createElement('ul');
            ul.style.listStyle = 'none';
            ul.style.padding = '0';
            ul.style.margin = '0';
            [...list].sort((a, b) => b.timestamp - a.timestamp).forEach(s => {
                const li = document.createElement('li');
                li.style.cssText = 'margin: 6px 0; padding: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; display: flex; justify-content: space-between; align-items: center; gap: 10px;';
                const date = new Date(s.timestamp).toLocaleString();
                li.innerHTML = `
                    <div style="flex: 1;">
                        <div style="font-weight: 500; color: var(--text);">${s.id}</div>
                        <div style="font-size: 0.7rem; color: var(--muted);">${date} · ${s.eventCount} events</div>
                    </div>
                    <div style="display: flex; gap: 6px;">
                        <button class="mini-btn" onclick="restoreSavedSessionById('${s.id}')" title="Restore to live buffer" style="border-color: var(--accent); color: var(--accent); font-size: 0.7rem; padding: 4px 8px;">Restore</button>
                        <button class="mini-btn" onclick="deleteSavedSession('${s.id}')" title="Delete" style="border-color: var(--red); color: var(--red); font-size: 0.7rem; padding: 4px 8px;">🗑️</button>
                    </div>
                `;
                ul.appendChild(li);
            });
            container.appendChild(ul);
            const count = document.createElement('p');
            count.style.cssText = 'color: var(--muted); font-size: 0.75rem; margin: 6px 0 0;';
            count.textContent = `${list.length} saved session${list.length === 1 ? '' : 's'}`;
            container.appendChild(count);
        }

        function saveCurrentSession() {
            if (liveBuffer.length === 0) { alert('No live events to save.'); return; }
            const list = getSavedSessions();
            const id = 'session_' + new Date().toISOString().replace(/[:.]/g, '-');
            list.push({ id, timestamp: Date.now(), eventCount: liveBuffer.length });
            saveSavedSessions(list);
            // Also store the actual data under its own key
            try {
                localStorage.setItem('exo_session_' + id, JSON.stringify(liveBuffer));
            } catch (e) { console.error('Failed to save session data:', e); }
            alert('Saved session with ' + liveBuffer.length + ' events.');
        }

        function restoreSavedSessionById(id) {
            try {
                const raw = localStorage.getItem('exo_session_' + id);
                if (!raw) { alert('Session data not found.'); return; }
                const saved = JSON.parse(raw);
                if (!Array.isArray(saved)) { alert('Invalid session data.'); return; }
                liveBuffer = saved.slice();
                if (liveBuffer.length > 1000) liveBuffer = liveBuffer.slice(-1000);
                liveCount = liveBuffer.length;
                pillCount.innerHTML = `<b>${liveCount}</b> event${liveCount === 1 ? '' : 's'}`;
                const empty = liveEvents.querySelector('.empty');
                if (empty) empty.remove();
                const toShow = liveBuffer.slice(-50).reverse();
                toShow.forEach(data => {
                    const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
                    const detailsVal = data.details && typeof data.details === 'object' ? data.details : {};
                    const detailsStr = Object.entries(detailsVal).slice(0, 3).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ');
                    const label = (data.category ? `[${data.category}] ` : '') + (data.event || 'Unknown');
                    const evtLine = document.createElement('div');
                    evtLine.className = 'evt';
                    evtLine.dataset.search = `${label.toLowerCase()} ${detailsStr.toLowerCase()} ${(data.raw || '').toLowerCase()} ${(data.tag || '').toLowerCase()}`;
                    evtLine.title = data.raw || JSON.stringify(data, null, 2);
                    const evtName = document.createElement('span'); evtName.className = 't'; evtName.textContent = label;
                    const evtTime = document.createElement('span'); evtTime.className = 'time'; evtTime.textContent = `${time} · ${data.rel ?? 0}s`;
                    const evtDet = document.createElement('span'); evtDet.className = 'd'; evtDet.textContent = detailsStr || (data.raw || '');
                    evtLine.append(evtTime, evtName, evtDet);
                    liveEvents.insertBefore(evtLine, liveEvents.firstChild);
                });
                liveFilterEl.oninput();
                console.log('[RESTORE] Restored saved session', id, 'with', liveBuffer.length, 'events');
            } catch (e) {
                console.error('Failed to restore saved session:', e);
                alert('Failed to restore session: ' + e.message);
            }
        }

        function deleteSavedSession(id) {
            if (!confirm('Delete this saved session?')) return;
            const list = getSavedSessions().filter(s => s.id !== id);
            saveSavedSessions(list);
            try { localStorage.removeItem('exo_session_' + id); } catch (e) {}
        }

        function initLiveEvents() {
            try { if (liveWs) liveWs.close(); } catch (e) {}
            const wsHost = window.location.hostname || 'localhost';
            liveWs = new WebSocket(`ws://${wsHost}:9090`);

            liveWs.onopen = () => setLiveStatus(true, 'tailing filtered tag');
            liveWs.onmessage = (event) => {
                try {
                    const parsed = JSON.parse(event.data);
                    console.log('[LIVE EVENT IN UI]', parsed.event, parsed);
                    addLiveEvent(parsed);
                }
                catch (e) { console.error('bad WS frame', e); }
            };
            liveWs.onclose = () => {
                setLiveStatus(false, 'retrying in 3s… (Run bridge.py in terminal)');
                setTimeout(initLiveEvents, 3000);
            };
            liveWs.onerror = () => { try { liveWs.close(); } catch (e) {} };
            restoreSavedSession();
        }

        // ── LIST UPLOADED JSON FILES ──
        async function loadUploadedFiles() {
            try {
                const resp = await fetch('/uploaded-files');
                if (resp.ok) {
                    const data = await resp.json();
                    displayFiles(data.files);
                } else {
                    showError("Failed to fetch file list from server");
                }
            } catch (err) {
                showError("Error connecting to upload server: " + err.message);
            }
        }

        function showError(message) {
            filesList.innerHTML = `<p style="color: var(--red);">⚠ ${message}</p>`;
        }

        function displayFiles(files) {
            filesList.innerHTML = '';
            if (!files || files.length === 0) {
                filesList.innerHTML = '<p style="color: var(--muted);">No JSON files uploaded yet</p>';
                return;
            }
            const ul = document.createElement('ul');
            ul.style.listStyle = 'none';
            ul.style.padding = '0';
            ul.style.margin = '0';
            [...files].sort().reverse().forEach(f => {
                const li = document.createElement('li');
                li.textContent = f;
                li.title = `Open ${f} in profiler`;
                li.onclick = () => loadAndOpenProfiler(f);
                ul.appendChild(li);
            });
            const count = document.createElement('p');
            count.style.cssText = 'color: var(--muted); font-size: 0.75rem; margin: 8px 0 0;';
            count.textContent = `${files.length} session${files.length === 1 ? '' : 's'} — click to open in profiler`;
            filesList.appendChild(ul);
            filesList.appendChild(count);
        }

        function loadAndOpenProfiler(filename) {
            // Profiler v3 already supports ?file=<url> → fetch → bootstrap.
            // Navigate there directly so click opens the full profiler.
            const fileUrl = `/uploads/${encodeURIComponent(filename)}`;
            window.location.href = `exoplayer_profiler_v4.html?file=${encodeURIComponent(fileUrl)}&name=${encodeURIComponent(filename)}&from=dashboard`;
        }

        // ── INITIALIZE ──
        // Auto-init: connect to WebSocket, load devices + files
        initLiveEvents();
        loadAdbDevices();
        setInterval(loadAdbDevices, 5000);
        loadUploadedFiles();
        setInterval(loadUploadedFiles, 5000);
        renderSavedSessions();
    