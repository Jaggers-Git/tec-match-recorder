/* TEC Match Recorder: dashboard */
(() => {
  'use strict';
  const $ = (sel) => document.querySelector(sel);
  const pad = (n) => String(n).padStart(2, '0');
  const ROUND_SUGGESTIONS = [
    'Pools', 'Winners Round 1', 'Winners Round 2', 'Winners Round 3', 'Winners Quarters', 'Winners Semis', 'Winners Finals',
    'Losers Round 1', 'Losers Round 2', 'Losers Round 3', 'Losers Round 4', 'Losers Quarters', 'Losers Semis', 'Losers Finals',
    'Grand Finals', 'Grand Finals Reset', 'Friendlies', 'Money Match',
  ];

  let S = null;              // latest state snapshot from the server
  let B = { sets: [] };      // latest bracket payload
  let fighters = [];
  let appOnline = false;
  let busy = false;
  let confirmArmed = false;
  let confirmTimer = null;
  let picker = { slot: 0, selected: [] };
  let lastBracketKey = '';
  let bracketEvent = '';       // start.gg event slug the bracket list is filtered to ('' = all)
  let bracketPool = '';        // pool identifier the bracket list is filtered to ('' = all)
  let pendingPatch = {};
  let patchTimer = null;
  let toastTimer = null;
  const seenStatus = new Map();

  // ---------- helpers ----------
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch { /* no body */ }
    if (res.status === 401 && data.pinRequired) showPin(data.error);
    if (!res.ok) throw new Error(data.error || `${method} ${path} failed (${res.status})`);
    return data;
  }
  // ---------- PIN (dashboard opened from another device) ----------
  function showPin(message) {
    const box = $('#pin');
    if (!box || !box.hidden) return;
    box.hidden = false;
    $('#pin-error').textContent = message && /wrong/i.test(message) ? message : '';
    setTimeout(() => $('#pin-input').focus(), 50);
  }
  $('#pin-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const pin = $('#pin-input').value.trim();
    const res = await fetch('/api/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
    if (res.ok) { location.reload(); return; }
    $('#pin-error').textContent = 'Wrong PIN, try again.';
    $('#pin-input').select();
  });
  function toast(message, { error = false, action = null, sticky = false } = {}) {
    const el = $('#toast');
    el.className = `toast${error ? ' error' : ''}`;
    el.innerHTML = `<span>${esc(message)}</span>`;
    if (action) {
      const b = document.createElement('button');
      b.className = 'small';
      b.textContent = action.label;
      b.addEventListener('click', action.onClick);
      el.appendChild(b);
    }
    const x = document.createElement('button');
    x.className = 'small';
    x.textContent = '✕';
    x.addEventListener('click', () => { el.hidden = true; });
    el.appendChild(x);
    el.hidden = false;
    clearTimeout(toastTimer);
    if (!sticky) toastTimer = setTimeout(() => { el.hidden = true; }, action ? 15000 : 6000);
  }
  function fmtClock(iso) {
    const d = new Date(iso);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
  function ago(iso) {
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }
  const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      return ok;
    }
  }
  function bibleRow(e) {
    return [e.p1, (e.chars1 || []).join(', '), e.p2, (e.chars2 || []).join(', '), e.round].join('\t');
  }
  async function copyRow(e) {
    const ok = await copyText(bibleRow(e));
    toast(ok ? 'Worksheet row copied. Paste it into the stream worksheet (columns B to F).' : 'Could not copy to the clipboard', { error: !ok });
  }

  // ---------- live updates ----------
  function connect() {
    const es = new EventSource('/api/events');
    es.addEventListener('state', (ev) => { S = JSON.parse(ev.data); appOnline = true; render(); });
    es.addEventListener('bracket', (ev) => { B = JSON.parse(ev.data); renderBracket(true); });
    es.onerror = () => {
      appOnline = false;
      renderBanner();
      // From another device the stream fails with 401 before the first event; ask for the PIN then.
      fetch('/api/state').then((r) => { if (r.status === 401) showPin(); }).catch(() => {});
    };
  }

  // ---------- rendering ----------
  function render() {
    if (!S) return;
    applyBranding();
    applySwitcher();
    renderUpdate();
    if (!$('#settings').hidden) { renderNetworkStatus(); renderArtStatus(); renderMaintenance(); renderLogoStatus(); }
    if (!$('#setup').hidden) renderSetup();
    maybeAutoOpenSetup();
    renderChips();
    renderBanner();
    renderCurrent();
    renderRecord();
    renderLog();
    renderRecent();
    renderBracket(false);
    renderSettingsStatus();
  }
  // ---------- branding (picked in Settings; /theme.js applies it before the first paint) ----------
  const TEC_MARK = $('#brand-mark').innerHTML;
  const TEC_ICON = document.querySelector('link[rel="icon"]').href;
  // Stand-in for a theme whose logo has not been saved yet.
  const TT_EMBLEM = '<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46" fill="#1a0d10" stroke="#F2B53A" stroke-width="6"/><circle cx="50" cy="50" r="36" fill="#6D2E3F"/><text x="50" y="62" text-anchor="middle" font-family="Urban Constructed, Oswald, Arial Narrow, sans-serif" font-weight="700" font-size="32" fill="#FCE319">TT</text></svg>';
  let brandKey = '';
  function applyBranding() {
    const b = S.branding || { theme: 'tec' };
    const key = [b.theme, b.logo, b.smashOnly, b.org].join('|');
    if (key === brandKey) return;
    brandKey = key;
    const tec = b.theme === 'tec';
    document.documentElement.dataset.theme = b.theme;
    document.documentElement.classList.toggle('smash-only', !!b.smashOnly);
    $('#brand-mark').innerHTML = tec ? TEC_MARK : b.logo ? `<img src="${esc(b.logo)}" alt="">` : TT_EMBLEM;
    $('#brand-org').textContent = b.org || 'Texas Esports Collective';
    document.title = tec ? 'TEC Match Recorder' : `${b.name} · Match Recorder`;
    document.querySelector('link[rel="icon"]').href = !tec && b.logo ? b.logo : TEC_ICON;
  }
  // OBS or vMix: .obs-only / .vmix-only blocks (the how-to guide) follow the saved choice, and every
  // .sw-name span outside Settings says which app it is.
  let swKey = '';
  function applySwitcher() {
    if (!S.sw || S.sw.id === swKey) return;
    swKey = S.sw.id;
    document.documentElement.dataset.sw = S.sw.id;
    for (const el of document.querySelectorAll('.sw-name')) if (!el.closest('#settings-form')) el.textContent = S.sw.name;
  }
  // S.sw is the production software in use: OBS or vMix.
  function swText() {
    const o = S.sw;
    if (o.status === 'connected') return `${o.name} ${o.version ? o.version + ' ' : ''}connected`;
    if (o.status === 'connecting') return `${o.name} connecting…`;
    if (o.status === 'auth-failed') return `${o.name}: wrong password`;
    return `${o.name} not connected`;
  }
  const isVmix = () => !!(S && S.sw && S.sw.id === 'vmix');
  function sgText() {
    const g = S.startgg;
    if (!g.configured) return 'start.gg: not set up (manual mode)';
    if (g.syncing) return 'start.gg: syncing…';
    if (g.status === 'live') return `start.gg LIVE · synced ${g.lastSync ? ago(g.lastSync) : 'now'}`;
    if (g.status === 'offline') return `start.gg OFFLINE · using bracket from ${g.updatedAt ? fmtClock(g.updatedAt) : 'cache'}`;
    if (g.status === 'error') return `start.gg error: ${g.lastError}`;
    return 'start.gg: waiting for first sync';
  }
  function renderChips() {
    const swChip = $('#chip-obs');
    swChip.textContent = swText();
    swChip.className = `chip ${S.sw.status === 'connected' ? 'ok' : S.sw.status === 'connecting' ? 'warn' : 'bad'}`;

    const sgChip = $('#chip-sg');
    sgChip.textContent = sgText();
    const g = S.startgg;
    sgChip.className = `chip ${!g.configured ? '' : g.status === 'live' ? 'ok' : g.status === 'offline' ? 'warn' : g.status === 'error' ? 'bad' : ''}`;

    const diskChip = $('#chip-disk');
    if (S.disk.freeBytes == null) { diskChip.textContent = 'Disk: unknown'; diskChip.className = 'chip'; }
    else { diskChip.textContent = `${gb(S.disk.freeBytes)} free`; diskChip.className = `chip ${S.disk.low ? 'bad' : 'ok'}`; }

    const ov = $('#chip-overlay');
    if (ov) {
      const o = S.overlay || {};
      if (!S.sw.connected) { ov.textContent = `Overlay: waiting for ${S.sw.name}`; ov.className = 'chip'; }
      else if (isVmix()) {
        if (o.installed && o.channel) { ov.textContent = `Overlay: live on vMix overlay ${o.channel}`; ov.className = 'chip ok'; }
        else if (o.installed) { ov.textContent = 'Overlay: in vMix, not on an overlay channel'; ov.className = 'chip warn'; }
        else { ov.textContent = 'Overlay: not in vMix yet'; ov.className = 'chip'; }
      } else if (o.installed) {
        const onScreen = o.currentScene && o.inScenes.includes(o.currentScene);
        ov.textContent = onScreen ? `Overlay: live in ${o.currentScene}` : `Overlay: in ${o.inScenes.join(', ')} (OBS is showing ${o.currentScene || 'another scene'})`;
        ov.className = `chip ${onScreen ? 'ok' : 'warn'}`;
      } else { ov.textContent = 'Overlay: not in OBS yet'; ov.className = 'chip'; }
    }
    const det = $('#chip-detect');
    if (det) {
      const d = S.detect || {};
      const gameNow = (S.config.gameList || []).find((g) => g.id === (S.current.game || 'ssbu'));
      if (!S.config.detect || !S.config.detect.enabled) { det.textContent = 'Detect: off'; det.className = 'chip'; }
      else if (gameNow && !gameNow.characters) { det.textContent = `Detect: not used for ${gameNow.name}`; det.className = 'chip'; }
      else if (S.train && S.train.running) { det.textContent = 'Detect: paused (training scan running)'; det.className = 'chip warn'; }
      else if (S.sw.connected && !S.sw.snapshots) { det.textContent = 'Detect: needs vMix on this PC'; det.className = 'chip'; }
      else if (!d.running) { det.textContent = `Detect: waiting for ${S.sw.name}`; det.className = 'chip'; }
      else if (d.error) { det.textContent = `Detect: ${d.error}`; det.className = 'chip bad'; }
      else if (d.lastResult) { det.textContent = `Detect: ${d.lastResult.p1} vs ${d.lastResult.p2} · ${ago(d.lastResult.at)}`; det.className = 'chip ok'; }
      else { det.textContent = `Detect: watching${d.hasAnchor ? '' : ' (untrained)'}`; det.className = `chip ${d.hasAnchor ? 'ok' : 'warn'}`; }
    }
  }
  function renderBanner() {
    const el = $('#banner');
    if (!appOnline) {
      el.textContent = updateTarget
        ? `Installing v${updateTarget}: the recorder is restarting. This page reloads by itself in a few seconds.`
        : `Lost contact with the recorder app (server.js). Restart it with "Start Recorder.bat". ${S && S.sw ? S.sw.name : 'OBS'} keeps recording in the meantime.`;
      el.className = 'banner';
      el.hidden = false;
      return;
    }
    if (!S) return;
    if (S.sw.status !== 'connected') {
      const hint = isVmix() ? 'start vMix and tick Settings → Web Controller → Enable.' : 'start OBS and enable Tools → WebSocket Server Settings.';
      el.textContent = `${S.sw.name} not connected: ${S.sw.lastError || hint}`;
      el.className = 'banner';
      el.hidden = false;
    } else if (S.disk.low) {
      el.textContent = `Low disk space: only ${gb(S.disk.freeBytes)} left on the recording drive.`;
      el.className = 'banner warn';
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  }
  function setInput(id, value) {
    const el = $(`#${id}`);
    if (document.activeElement === el) return;
    if (el.value !== (value || '')) el.value = value || '';
  }
  function charChips(list, slot) {
    const auto = new Set(S.current[`auto${slot}`] || []);
    return (list || []).map((c) => `<span class="tag${auto.has(c) ? ' auto' : ''}"${auto.has(c) ? ' title="Detected automatically from the VS screen"' : ''}>${esc(c)}${auto.has(c) ? '<em>auto</em>' : ''}<button data-remove-char="${slot}" data-name="${esc(c)}" title="Remove">✕</button></span>`).join('');
  }
  function renderCurrent() {
    const c = S.current;
    setInput('p1', c.p1);
    setInput('p2', c.p2);
    setInput('round', c.round);
    setInput('setLetter', c.setLetter);
    $('#chars1').innerHTML = charChips(c.chars1, 1);
    $('#chars2').innerHTML = charChips(c.chars2, 2);
    $('#score1').textContent = c.score1 || 0;
    $('#score2').textContent = c.score2 || 0;
    // Game-win pips for Bo3/Bo5 (tap a pip to set the count; tap the last lit pip to undo).
    const bestOf = Number(c.bestOf) || 1;
    const need = bestOf === 5 ? 3 : bestOf === 3 ? 2 : 0;
    const bo = $('#best-of');
    if (document.activeElement !== bo && bo.value !== String(bestOf)) bo.value = String(bestOf);
    for (const side of [1, 2]) {
      $(`#games${side}`).hidden = !need;
      const wins = Number(c[`wins${side}`]) || 0;
      $(`#wins${side}`).innerHTML = Array.from({ length: need }, (_, i) =>
        `<button type="button" class="pip${i < wins ? ' on' : ''}" data-win-side="${side}" data-win-n="${i + 1}" title="Game ${i + 1}"></button>`).join('');
    }
    // Game selector: options come from the server's game registry; the profile decides whether
    // character chips make sense for this game at all.
    const games = S.config.gameList || [];
    const sel = $('#current-game');
    const want = games.map((g) => `${g.id}|${g.name}`).join(',');
    if (sel.dataset.options !== want) { sel.dataset.options = want; sel.innerHTML = games.map((g) => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join(''); }
    if (document.activeElement !== sel && sel.value !== (c.game || 'ssbu')) sel.value = c.game || 'ssbu';
    sel.hidden = games.length < 2;
    const profile = games.find((g) => g.id === (c.game || 'ssbu')) || { characters: true };
    for (const el of document.querySelectorAll('.chars')) el.hidden = !profile.characters;
    $('#current-source').textContent = c.source === 'startgg' && c.setId ? `from start.gg set ${c.setLetter || ''}${c.eventName ? ` · ${c.eventName}` : ''}` : 'manual entry';
    $('#btn-unmark').hidden = !(c.setId && (S.recordedSetIds || []).includes(c.setId));
    $('#preview-title').textContent = S.preview.title;
    // The real extension is whatever the app records to: show the last saved file's, else each app's default.
    const lastFile = ((S.log || []).find((e) => e.filename) || {}).filename || '';
    const ext = (/\.[a-z0-9]+$/i.exec(lastFile) || [isVmix() ? '.mp4' : '.mkv'])[0];
    $('#preview-file').textContent = `${S.preview.filenameBase}${ext}`;
  }
  function renderRecord() {
    if (!S) return;
    const btn = $('#btn-record');
    const st = $('#record-status');
    const connected = S.sw.connected;
    const name = S.sw.name;
    if (S.rec.active) {
      btn.className = `record-btn recording${confirmArmed ? ' armed' : ''}`;
      btn.textContent = confirmArmed ? 'TAP AGAIN TO END & SAVE' : 'END & SAVE';
      btn.disabled = busy || !connected;
      const secs = (Date.now() - S.rec.startedAt) / 1000;
      const who = S.current.p1 || S.current.p2 ? ` · ${S.current.p1 || '?'} vs ${S.current.p2 || '?'}` : '';
      st.innerHTML = `<span class="rec-dot"></span>RECORDING ${fmtDur(secs)}${who}${S.rec.startedByApp ? '' : ` (started from ${name})`}`;
      if (!connected) st.innerHTML += `<br>${name} connection lost. Stop the recording in ${name} if needed.`;
    } else {
      btn.className = 'record-btn';
      btn.textContent = connected ? 'START RECORDING' : `${name.toUpperCase()} NOT CONNECTED`;
      btn.disabled = busy || !connected;
      st.textContent = connected ? 'Pick a set or enter the players, then start. Names can still be fixed while recording.' : '';
    }
  }
  function gameShort(id) {
    const g = ((S && S.config.gameList) || []).find((x) => x.id === id);
    return g ? g.short : '';
  }
  function stateLabel(s) {
    return { completed: 'Done', in_progress: 'In progress', called: 'Called', pending: '' }[s.state] || '';
  }
  function renderBracket(force) {
    const sets = B.sets || [];
    const q = $('#bracket-search').value.trim().toLowerCase();
    const hideDone = $('#opt-hide-done').checked;
    const showTbd = $('#opt-show-tbd').checked;
    const recorded = new Set((S && S.recordedSetIds) || []);
    const selected = S && S.current.setId;
    const events = B.events || [];
    if (bracketEvent && !events.some((e) => e.slug === bracketEvent)) bracketEvent = '';
    const key = [B.updatedAt, sets.length, q, hideDone, showTbd, selected, recorded.size, bracketEvent, events.length, bracketPool].join('|');
    if (!force && key === lastBracketKey) return;
    lastBracketKey = key;

    $('#bracket-title').textContent = B.tournamentName ? `${B.tournamentName} · ${B.eventName}` : '';
    const tabsEl = $('#bracket-events');
    tabsEl.hidden = events.length < 2;
    tabsEl.innerHTML = events.length < 2 ? '' : [`<button class="evtab${bracketEvent ? '' : ' active'}" data-event="">All (${sets.length})</button>`]
      .concat(events.map((e) => `<button class="evtab${bracketEvent === e.slug ? ' active' : ''}" data-event="${esc(e.slug)}">${esc(e.eventName)}${gameShort(e.game) ? ` <em>${esc(gameShort(e.game))}</em>` : ''} (${e.setCount})</button>`)).join('');
    // Pool filter: only for phases that run several pools, where set letters repeat per pool.
    const poolEl = $('#bracket-pools');
    const poolSets = bracketEvent ? sets.filter((s) => s.eventSlug === bracketEvent) : sets;
    const pools = [...new Set(poolSets.filter((s) => s.multiPool && s.pool).map((s) => s.pool))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (bracketPool && !pools.includes(bracketPool)) bracketPool = '';
    // With several brackets loaded, pool chips only make sense inside one event tab.
    poolEl.hidden = pools.length < 2 || (events.length > 1 && !bracketEvent);
    poolEl.innerHTML = pools.length < 2 ? '' : [`<button class="evtab${bracketPool ? '' : ' active'}" data-pool="">All pools</button>`]
      .concat(pools.map((p) => `<button class="evtab${bracketPool === p ? ' active' : ''}" data-pool="${esc(p)}">Pool ${esc(p)}</button>`)).join('');
    const status = $('#bracket-status');
    if (S && !S.startgg.configured) {
      status.innerHTML = 'No start.gg event yet. Open <b>Settings</b>, paste the event URL and an API token. Manual entry works without it.';
    } else if (!sets.length) {
      status.textContent = S && S.startgg.status === 'error' ? S.startgg.lastError : 'No sets yet. The bracket may not be generated yet; waiting for the next sync…';
    } else {
      status.textContent = '';
    }

    const visible = sets.filter((s) => {
      if (bracketEvent && s.eventSlug !== bracketEvent) return false;
      if (bracketPool && s.pool !== bracketPool) return false;
      if (!showTbd && !s.p1 && !s.p2) return false;
      if (hideDone && s.state === 'completed' && !recorded.has(s.id)) return false;
      if (q) {
        const hay = `${s.p1} ${s.p2} ${s.round} ${s.roundLabel} ${s.letter} ${s.phase} ${s.pool}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    visible.sort((a, b) => (a.phaseIdx - b.phaseIdx)
      || String(a.multiPool ? a.pool || '' : '').localeCompare(String(b.multiPool ? b.pool || '' : ''), undefined, { numeric: true })
      || ((a.roundNum > 0 ? 0 : 1) - (b.roundNum > 0 ? 0 : 1))
      || (Math.abs(a.roundNum) - Math.abs(b.roundNum))
      || String(a.letter).localeCompare(String(b.letter), undefined, { numeric: true }));

    let html = '';
    let lastGroup = null;
    for (const s of visible) {
      const group = `${s.phase ? `${s.phase} · ` : ''}${s.multiPool && s.pool ? `Pool ${s.pool} · ` : ''}${s.roundLabel}`;
      if (group !== lastGroup) { html += `<div class="round-head">${esc(group)}</div>`; lastGroup = group; }
      const isRec = recorded.has(s.id);
      const sharedGame = events.filter((e) => e.game === s.game).length > 1;
      const meta = [events.length > 1 && !bracketEvent ? ((sharedGame ? s.eventName : gameShort(s.game)) || s.eventName || '') : '', (s.isPools || s.multiPool) && s.pool ? `Pool ${s.pool}` : '', stateLabel(s), isRec ? '🎥 recorded' : ''].filter(Boolean).join(' · ');
      html += `<button class="set-card state-${s.state}${selected === s.id ? ' selected' : ''}${isRec ? ' recorded' : ''}" data-id="${esc(s.id)}">
        <span class="letter">${esc(s.letter) || '·'}</span>
        <span class="names"><b>${esc(s.p1) || 'TBD'}</b><i>vs</i><b>${esc(s.p2) || 'TBD'}</b></span>
        <span class="meta">${esc(meta) || '&nbsp;'}</span>
      </button>`;
    }
    if (!html && sets.length) {
      const hiddenDone = hideDone ? sets.filter((s) => s.state === 'completed' && !recorded.has(s.id)).length : 0;
      html = hiddenDone === sets.length
        ? `<div class="muted">All ${sets.length} sets in this bracket are completed. Untick "Hide completed" to browse them.</div>`
        : `<div class="muted">No sets match the current filter${hiddenDone ? ` (${hiddenDone} completed sets hidden)` : ''}.</div>`;
    }
    $('#bracket-list').innerHTML = html;
  }
  function renderLog() {
    const tbody = $('#log-table tbody');
    const entries = S.log || [];
    $('#log-empty').hidden = entries.length > 0;
    for (const e of entries) {
      const prev = seenStatus.get(e.id);
      if (prev && prev !== e.status) {
        if (e.status === 'saved') toast(`Saved: ${e.filename}`, { action: { label: 'Copy worksheet row', onClick: () => copyRow(e) } });
        else if (e.status === 'error') toast(`Could not save "${e.title}": ${e.error}`, { error: true, sticky: true });
      }
      seenStatus.set(e.id, e.status);
    }
    tbody.innerHTML = entries.map((e) => {
      const p1 = `${esc(e.p1)}${e.chars1 && e.chars1.length ? ` <span class="muted">(${esc(e.chars1.join(', '))})</span>` : ''}`;
      const p2 = `${esc(e.p2)}${e.chars2 && e.chars2.length ? ` <span class="muted">(${esc(e.chars2.join(', '))})</span>` : ''}`;
      const file = e.status === 'saved' ? esc(e.filename) : esc(`${e.filenameBase}…`);
      const badge = e.status === 'saved' ? '<span class="badge saved">saved</span>'
        : e.status === 'saving' ? '<span class="badge saving">saving…</span>'
          : `<span class="badge error" title="${esc(e.error)}">error</span>`;
      const actions = `<button class="small" data-copy="${esc(e.id)}">Copy row</button>${e.status === 'error' ? ` <button class="small" data-retry="${esc(e.id)}">Retry</button>` : ''}`;
      return `<tr><td>${fmtClock(e.ts)}</td><td>${esc(e.set)}</td><td>${esc(e.round)}</td><td>${p1}</td><td>${p2}</td><td>${fmtDur(e.durationSec)}</td><td class="mono">${file}${e.status === 'error' ? `<div class="err">${esc(e.error)}</div>` : ''}</td><td>${badge}</td><td class="nowrap">${actions}</td></tr>`;
    }).join('');
  }
  function renderRecent() {
    const names = S.recentPlayers || [];
    $('#recent-list').innerHTML = names.map((n) => `<option value="${esc(n)}">`).join('');
    $('#recent-players').innerHTML = names.length
      ? names.map((n) => `<button class="small" data-recent="${esc(n)}">${esc(n)}</button>`).join('')
      : '<span class="muted">No players yet. They appear here after the first saved set.</span>';
  }
  function renderSettingsStatus() {
    if ($('#settings').hidden || !S) return;
    const swStatus = `${swText()}${S.sw.lastError && S.sw.status !== 'connected' ? `: ${S.sw.lastError}` : ''}`;
    $('#settings-obs-status').textContent = isVmix() ? 'Not in use: the production software is vMix.' : swStatus;
    $('#settings-vmix-status').textContent = isVmix() ? swStatus : 'Not in use: the production software is OBS.';
    $('#settings-sg-status').textContent = S.startgg.configured ? `${sgText()}${S.startgg.tournamentName ? ` · ${S.startgg.tournamentName} / ${S.startgg.eventName} (${S.startgg.setCount} sets)` : ''}` : 'Not configured. Get a token at start.gg → your profile → Developer Settings → Create new token.';
    $('#settings-info').innerHTML = `Recordings folder (from ${esc(S.sw.name)}): <span class="mono">${esc(S.sw.recordDirectory || (isVmix() ? '(read from vMix on the first recording)' : '(connect OBS to read it)'))}</span><br>`
      + `Dashboard on this network: ${(S.lan || []).map((u) => `<span class="mono">${esc(u)}</span>`).join(' · ') || 'none'}`;
  }

  // ---------- current-set editing ----------
  function queuePatch(patch) {
    Object.assign(pendingPatch, patch);
    clearTimeout(patchTimer);
    patchTimer = setTimeout(flushPatch, 250);
  }
  async function flushPatch() {
    clearTimeout(patchTimer);
    const p = pendingPatch;
    pendingPatch = {};
    if (!Object.keys(p).length) return;
    try { await api('PATCH', '/api/current', p); } catch (e) { toast(e.message, { error: true }); }
  }
  for (const f of ['p1', 'p2', 'round', 'setLetter']) {
    const el = $(`#${f}`);
    el.addEventListener('input', () => queuePatch({ [f]: el.value }));
    el.addEventListener('change', () => { queuePatch({ [f]: el.value }); flushPatch(); });
  }
  $('#btn-clear').addEventListener('click', async () => {
    pendingPatch = {};
    try { await api('POST', '/api/current/clear'); } catch (e) { toast(e.message, { error: true }); }
  });
  $('#btn-swap').addEventListener('click', async () => {
    await flushPatch();
    try { await api('POST', '/api/current/swap'); } catch (e) { toast(e.message, { error: true }); }
  });
  document.addEventListener('click', async (ev) => {
    const rm = ev.target.closest('[data-remove-char]');
    if (rm) {
      const slot = rm.dataset.removeChar;
      const list = (S.current[`chars${slot}`] || []).filter((c) => c !== rm.dataset.name);
      try { await api('PATCH', '/api/current', { [`chars${slot}`]: list }); } catch (e) { toast(e.message, { error: true }); }
      return;
    }
    const pick = ev.target.closest('[data-pick]');
    if (pick) { openPicker(Number(pick.dataset.pick)); return; }
    const recent = ev.target.closest('[data-recent]');
    if (recent) {
      const name = recent.dataset.recent;
      const field = !S.current.p1 ? 'p1' : 'p2';
      try { await api('PATCH', '/api/current', { [field]: name, source: 'manual' }); } catch (e) { toast(e.message, { error: true }); }
      return;
    }
    const card = ev.target.closest('.set-card');
    if (card) {
      try { await api('POST', '/api/select-set', { id: card.dataset.id }); } catch (e) { toast(e.message, { error: true }); }
      return;
    }
    const copy = ev.target.closest('[data-copy]');
    if (copy) { const e = S.log.find((x) => x.id === copy.dataset.copy); if (e) copyRow(e); return; }
    const retry = ev.target.closest('[data-retry]');
    if (retry) { try { await api('POST', '/api/log/retry', { id: retry.dataset.retry }); } catch (e) { toast(e.message, { error: true }); } }
  });

  // ---------- record button ----------
  $('#btn-record').addEventListener('click', async () => {
    if (!S || busy) return;
    await flushPatch();
    if (!S.rec.active) {
      busy = true; renderRecord();
      try { await api('POST', '/api/record/start'); } catch (e) { toast(e.message, { error: true }); }
      busy = false; renderRecord();
      return;
    }
    if (!confirmArmed) {
      confirmArmed = true; renderRecord();
      confirmTimer = setTimeout(() => { confirmArmed = false; renderRecord(); }, 4000);
      return;
    }
    clearTimeout(confirmTimer);
    confirmArmed = false;
    busy = true; renderRecord();
    try {
      const r = await api('POST', '/api/record/stop');
      toast(`Stopped. Saving "${r.entry.title}"…`);
    } catch (e) { toast(e.message, { error: true }); }
    busy = false; renderRecord();
  });

  // ---------- character picker ----------
  function openPicker(slot) {
    picker = { slot, selected: [...(S.current[`chars${slot}`] || [])] };
    $('#picker-title').textContent = `Characters for ${S.current[`p${slot}`] || `Player ${slot}`}`;
    $('#picker-search').value = '';
    renderPicker();
    $('#picker').hidden = false;
    $('#picker-search').focus();
  }
  function filteredFighters() {
    const q = $('#picker-search').value.trim().toLowerCase();
    if (!q) return fighters;
    return fighters.filter((f) => f.name.toLowerCase().includes(q) || (f.aliases || []).some((a) => a.toLowerCase().includes(q)));
  }
  function renderPicker() {
    $('#picker-selected').innerHTML = picker.selected.length
      ? picker.selected.map((c) => `<span class="tag">${esc(c)}<button data-unpick="${esc(c)}">✕</button></span>`).join('')
      : '<span class="muted">Tap fighters in the order they were played. Leave empty if unknown.</span>';
    $('#picker-grid').innerHTML = filteredFighters().map((f) => `<button type="button" class="fighter${picker.selected.includes(f.name) ? ' on' : ''}" data-fighter="${esc(f.name)}">${esc(f.name)}</button>`).join('');
  }
  function togglePick(name) {
    if (picker.selected.includes(name)) picker.selected = picker.selected.filter((c) => c !== name);
    else picker.selected.push(name);
    renderPicker();
  }
  $('#picker-search').addEventListener('input', renderPicker);
  $('#picker-search').addEventListener('keydown', (ev) => {
    const isEnter = ev.key === 'Enter' || ev.key === 'Return' || ev.keyCode === 13;
    const isEscape = ev.key === 'Escape' || ev.key === 'Esc' || ev.keyCode === 27;
    if (isEnter) {
      ev.preventDefault();
      const first = filteredFighters()[0];
      if (first) { togglePick(first.name); $('#picker-search').value = ''; renderPicker(); }
    } else if (isEscape) {
      closePicker();
    }
  });
  $('#picker').addEventListener('click', (ev) => {
    const f = ev.target.closest('[data-fighter]');
    if (f) { togglePick(f.dataset.fighter); return; }
    const u = ev.target.closest('[data-unpick]');
    if (u) { togglePick(u.dataset.unpick); return; }
    if (ev.target === $('#picker')) closePicker();
  });
  async function closePicker() {
    $('#picker').hidden = true;
    try { await api('PATCH', '/api/current', { [`chars${picker.slot}`]: picker.selected }); } catch (e) { toast(e.message, { error: true }); }
  }
  $('#picker-done').addEventListener('click', closePicker);

  // ---------- settings ----------
  function openSettings() {
    const c = S.config;
    const f = $('#settings-form');
    const set = (name, v) => {
      const el = f.elements[name];
      if (!el) return;
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? '';
    };
    set('branding.theme', (c.branding && c.branding.theme) || 'tec');
    set('branding.label', c.branding ? c.branding.label : '');
    set('smashOnly', c.smashOnly);
    f.dataset.theme = f.elements['branding.theme'].value;
    set('event.name', c.event.name);
    for (const g of c.gameListAll || c.gameList || []) set(`games.${g.id}.suffix`, g.suffix);
    set('startgg.eventUrls', (c.startgg.eventUrls || []).join('\n'));
    set('startgg.token', '');
    f.elements['startgg.token'].placeholder = c.startgg.hasToken ? '(saved, leave blank to keep)' : 'paste your start.gg API token';
    set('startgg.pollSeconds', c.startgg.pollSeconds);
    set('switcher', c.switcher || 'obs');
    set('obs.host', c.obs.host);
    set('obs.port', c.obs.port);
    set('obs.password', '');
    f.elements['obs.password'].placeholder = c.obs.hasPassword ? '(saved, leave blank to keep)' : 'OBS → Tools → WebSocket Server Settings';
    const vm = c.vmix || {};
    set('vmix.host', vm.host || '127.0.0.1');
    set('vmix.port', vm.port || 8088);
    set('vmix.user', vm.user || '');
    set('vmix.password', '');
    f.elements['vmix.password'].placeholder = vm.hasPassword ? '(saved, leave blank to keep)' : '(only if the Web Controller has one)';
    set('vmix.overlayChannel', String(vm.overlayChannel || 0));
    set('vmix.recordDirectory', vm.recordDirectory || '');
    setFormSwitcher();
    set('naming.titleTemplate', c.naming.titleTemplate);
    set('naming.filenamePrefix', c.naming.filenamePrefix);
    set('naming.filenamePrefixTemplate', c.naming.filenamePrefixTemplate);
    set('naming.stripPrefixes', c.naming.stripPrefixes);
    set('naming.eventSubfolder', c.naming.eventSubfolder);
    set('detect.enabled', c.detect && c.detect.enabled);
    set('detect.intervalMs', c.detect ? c.detect.intervalMs : 1000);
    set('detect.videosFolder', c.detect ? c.detect.videosFolder : '');
    loadSources(c.detect ? c.detect.source : '');
    set('overlay.center', c.overlay ? c.overlay.center : 'round');
    set('overlay.scores', !c.overlay || c.overlay.scores !== false);
    set('network.lan', c.network && c.network.lan);
    set('network.pin', c.network ? c.network.pin : '');
    set('detect.samplesMaxMb', c.detect && c.detect.samplesMaxMb !== undefined ? c.detect.samplesMaxMb : 500);
    $('#about-version').textContent = `TEC Match Recorder v${S.version || '?'}`;
    renderNetworkStatus();
    renderArtStatus();
    renderMaintenance();
    renderLogoStatus();
    refreshOverlayStatus();
    $('#settings').hidden = false;
    renderSettingsStatus();
  }
  // The OBS and vMix rows in Settings follow the form's choice, so they switch before saving.
  const formSwitcher = () => $('#settings-form').elements.switcher.value;
  function setFormSwitcher() {
    const f = $('#settings-form');
    f.dataset.sw = formSwitcher();
    const name = formSwitcher() === 'vmix' ? 'vMix' : 'OBS';
    for (const el of f.querySelectorAll('.sw-name')) el.textContent = name;
    const pending = S && S.sw && S.sw.id !== formSwitcher();
    $('#switcher-pending').hidden = !pending;
  }
  $('#settings-form').elements.switcher.addEventListener('change', setFormSwitcher);
  function renderNetworkStatus() {
    const el = $('#network-status');
    if (!el || !S) return;
    const n = S.network || {};
    const name = S.sw ? S.sw.name : 'OBS';
    if (!n.lan) { el.textContent = `Only this PC can open the dashboard right now. The overlay in ${name} on this PC keeps working either way.`; return; }
    const urls = (S.lan || []).join('   ');
    el.textContent = `Other devices open: ${urls || '(no network address found)'}   PIN: ${n.pin || '(set on save)'}. ${name} on another PC: add ?pin=${n.pin || 'PIN'} to the overlay URL.`;
  }
  function renderArtStatus() {
    const el = $('#art-status');
    if (!el || !S || !S.art) return;
    const a = S.art;
    const job = a.job;
    const btn = $('#btn-art-download');
    if (job && job.running) {
      el.textContent = job.total ? `Downloading: ${job.done} of ${job.total} files${job.failed ? `, ${job.failed} failed` : ''}` : 'Downloading: listing files';
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
    el.textContent = a.portrait.files ? `Portraits on this PC: ${a.portrait.files} files.${job && job.error ? ` Last download failed: ${job.error}` : ''}` : `Not downloaded yet.${job && job.error ? ` Last download failed: ${job.error}` : ''}`;
  }
  $('#btn-art-download').addEventListener('click', async () => {
    try {
      await api('POST', '/api/art/download', { pack: 'portrait' });
      toast('Downloading the portrait pack. The detector picks it up when the download finishes.');
      renderArtStatus();
    } catch (e) { toast(e.message, { error: true }); }
  });
  // ---------- theme logo (Settings, Look and games) ----------
  // The buttons act on the theme picked in the form, so a logo can be set before the theme is saved.
  const formTheme = () => $('#theme-select').value;
  function renderLogoStatus() {
    if (!S || !S.branding) return;
    const url = (S.branding.logos || {})[formTheme()] || '';
    const img = $('#logo-preview');
    img.hidden = !url;
    if (url && img.getAttribute('src') !== url) img.src = url;
    const sg = S.startgg || {};
    $('#logo-status').textContent = url ? 'Logo saved on this PC.'
      : `No logo yet, so a plain TT badge stands in. ${sg.configured ? 'Use the start.gg tournament logo, or choose an image.' : 'Choose an image, or add the start.gg event and token above, save, and use the start.gg logo.'}`;
  }
  $('#theme-select').addEventListener('change', () => {
    const f = $('#settings-form');
    f.dataset.theme = formTheme();
    // Tuesday Takedown is an Ultimate-only monthly; preselect Smash-only (it can still be unticked).
    if (formTheme() === 'tt') f.elements.smashOnly.checked = true;
    if (formTheme() === 'tt' && !f.elements['branding.label'].value) f.elements['branding.label'].value = 'Tuesday Takedown';
    renderLogoStatus();
  });
  $('#btn-logo-startgg').addEventListener('click', async () => {
    const out = $('#logo-status');
    out.textContent = 'Fetching the logo from start.gg…';
    try {
      const r = await api('POST', `/api/branding/logo/startgg?theme=${encodeURIComponent(formTheme())}`);
      S.branding = r.branding;
      renderLogoStatus();
      toast(`Logo saved from ${r.tournament} on start.gg.`);
    } catch (e) { out.textContent = e.message; }
  });
  $('#logo-file').addEventListener('change', async () => {
    const file = $('#logo-file').files[0];
    $('#logo-file').value = '';
    if (!file) return;
    try {
      const res = await fetch(`/api/branding/logo?theme=${encodeURIComponent(formTheme())}`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
      S.branding = data.branding;
      renderLogoStatus();
      toast('Logo saved.');
    } catch (e) { toast(e.message, { error: true }); }
  });
  $('#btn-logo-remove').addEventListener('click', async () => {
    try {
      const r = await api('DELETE', `/api/branding/logo?theme=${encodeURIComponent(formTheme())}`);
      S.branding = r.branding;
      renderLogoStatus();
    } catch (e) { toast(e.message, { error: true }); }
  });
  // ---------- maintenance (Settings) ----------
  const fmtMb = (b) => `${(Number(b || 0) / 1048576).toFixed(Number(b || 0) > 100 * 1048576 ? 0 : 1)} MB`;
  function testRecText(t) {
    if (!t) return 'Not run yet.';
    if (t.running) return `Recording a ${t.seconds}-second test in ${S && S.sw ? S.sw.name : 'OBS'}...`;
    if (t.ok) return `OK: ${fmtMb(t.bytes)} written to ${t.dir}, test file removed (${new Date(t.at).toLocaleTimeString()}).`;
    return `Failed: ${t.error}`;
  }
  function renderMaintenance() {
    if (!S) return;
    const tr = $('#test-rec-status'); if (tr) tr.textContent = testRecText(S.testRec);
    const tb = $('#btn-test-rec'); if (tb) tb.disabled = !!(S.testRec && S.testRec.running);
    const ss = $('#samples-status');
    if (ss && S.samples) ss.textContent = `${fmtMb(S.samples.bytes)} in ${S.samples.files} frames${S.samples.maxMb ? ` (cap ${S.samples.maxMb} MB)` : ' (no cap)'}`;
  }
  async function runTestRecording() {
    try {
      const r = await api('POST', '/api/record/test', { seconds: 5 });
      toast(`Test recording OK: ${fmtMb(r.bytes)} in ${r.dir}. Test file removed.`);
    } catch (e) { toast(e.message, { error: true }); }
  }
  $('#btn-test-rec').addEventListener('click', runTestRecording);
  $('#btn-samples-clear').addEventListener('click', async () => {
    try {
      const r = await api('POST', '/api/detect/samples/clear');
      toast(`Removed ${r.removed} sample frames, ${fmtMb(r.bytes)} left (frames waiting for review are kept).`);
      if (S) { S.samples = r; renderMaintenance(); }
    } catch (e) { toast(e.message, { error: true }); }
  });
  $('#btn-update-check').addEventListener('click', async () => {
    const out = $('#update-status');
    out.textContent = 'Checking...';
    try {
      const r = await api('POST', '/api/update/check');
      if (r.error) out.textContent = `v${r.version}. ${r.error}.`;
      else if (r.upToDate) out.textContent = `v${r.version} is the latest release.`;
      else {
        const notes = `<a href="${esc(r.url)}" target="_blank" rel="noopener">release notes</a>`;
        out.innerHTML = r.canInstall
          ? `v${esc(r.version)} installed, v${esc(r.latest)} is available (${notes}). <button type="button" id="btn-update-install" class="small primary">Update now</button>`
          : `v${esc(r.version)} installed, v${esc(r.latest)} is available (${notes}). ${esc(r.why || '')}`;
      }
    } catch (e) { out.textContent = e.message; }
  });
  // ---------- in-app update: download, install, restart, then this page reloads on the new version ----------
  let updateTarget = '';
  document.addEventListener('click', async (ev) => {
    if (!ev.target.closest('#btn-update-install')) return;
    if (!confirm('Download and install the update now? The recorder restarts by itself in this window (about 10 seconds). Settings, the session log and recordings are kept.')) return;
    try {
      await api('POST', '/api/update/install');
      ev.target.disabled = true;
      toast('Updating. The recorder restarts by itself when the new version is installed.');
    } catch (e) { toast(e.message, { error: true }); }
  });
  function updateText(u) {
    if (!u) return '';
    const mb = (b) => (Number(b || 0) / 1048576).toFixed(1);
    switch (u.stage) {
      case 'checking': return 'Update: asking GitHub for the latest release...';
      case 'downloading': return `Update: downloading v${u.target}, ${mb(u.received)}${u.total ? ` of ${mb(u.total)}` : ''} MB...`;
      case 'verifying': return `Update: checking the v${u.target} download...`;
      case 'unpacking': case 'installing': return `Update: installing v${u.target}...`;
      case 'restarting': return `Update: v${u.target} installed. Restarting the recorder...`;
      case 'installed-manual': return `Update: v${u.target} installed. Close the black window and start the recorder again to finish.`;
      case 'failed': return `Update failed: ${u.error}. The recorder keeps running this version.`;
      default: return '';
    }
  }
  function renderUpdate() {
    const u = S && S.update;
    if (!u) return;
    const text = updateText(u);
    const out = $('#update-status');
    if (out && text && out.dataset.stage !== `${u.stage}|${u.received || 0}`) { out.dataset.stage = `${u.stage}|${u.received || 0}`; out.textContent = text; }
    if (u.stage === 'restarting' && !updateTarget) { updateTarget = u.target; waitForNewVersion(); }
  }
  // While the app restarts the page loses its connection; poll until the new version answers, then reload.
  async function waitForNewVersion() {
    const until = Date.now() + 120000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const v = await fetch('/api/version', { cache: 'no-store' }).then((r) => r.json());
        if (v.version === updateTarget) { location.reload(); return; }
      } catch { /* still restarting */ }
    }
    toast('The recorder has not come back after the update. Check its black window, or run Start Recorder.bat again.', { error: true, sticky: true });
  }

  // ---------- setup checklist (optional; opens at startup until dismissed) ----------
  let setupAutoOpened = false;
  function maybeAutoOpenSetup() {
    if (setupAutoOpened || !S || !S.config) return;
    setupAutoOpened = true;
    if (!(S.config.setup && S.config.setup.dismissed)) openSetup();
  }
  function openSetup() {
    $('#setup-dismiss').checked = !!(S && S.config.setup && S.config.setup.dismissed);
    $('#setup').hidden = false;
    renderSetup();
  }
  function setupItems() {
    const gb = S.disk && S.disk.freeBytes != null ? `${(S.disk.freeBytes / 1024 ** 3).toFixed(0)} GB free` : '';
    const sg = S.startgg || {};
    const art = S.art && S.art.portrait ? S.art.portrait.files : 0;
    const t = S.testRec;
    const o = S.sw;
    const vm = isVmix();
    return [
      o.connected
        ? { state: 'ok', title: `${o.name} connected${o.version ? ` (${o.version})` : ''}`, text: 'The recorder can start and stop recordings.' }
        : vm
          ? { state: 'warn', title: 'vMix not connected', text: 'In vMix open Settings, Web Controller, tick Enable (port 8088). Running vMix on another PC? Put its address in Settings, vMix. Using OBS instead? Switch Production software in Settings.', action: 'settings', label: 'Open Settings' }
          : { state: 'warn', title: 'OBS not connected', text: 'In OBS open Tools, WebSocket Server Settings, tick Enable WebSocket server, then paste the password from Show Connect Info into Settings. Using vMix instead? Switch Production software in Settings.', action: 'settings', label: 'Open Settings' },
      o.recordDirectory
        ? { state: S.disk && S.disk.low ? 'warn' : 'ok', title: 'Recording folder', text: `${o.recordDirectory}${gb ? `, ${gb}` : ''}${S.disk && S.disk.low ? '. Under 25 GB: make room before the event.' : ''}` }
        : { state: 'opt', title: 'Recording folder', text: vm ? 'Read from vMix on the first recording: run the test recording below. vMix picks the folder and format under Settings, Recording.' : 'Read from OBS once it connects (Settings, Output, Recording path in OBS).' },
      sg.configured
        ? { state: 'ok', title: 'start.gg bracket', text: `${sg.tournamentName || 'Event'}: ${sg.setCount} sets loaded.` }
        : { state: 'opt', title: 'start.gg bracket (optional)', text: 'Paste an API token and the event URL in Settings to pick sets from the live bracket. Typing names by hand works without it.', action: 'settings', label: 'Open Settings' },
      art > 0
        ? { state: 'ok', title: 'Character art', text: `${art} portraits on this PC for automatic character tags and title cards.` }
        : { state: 'opt', title: 'Character art (optional)', text: 'Needed only for automatic character tags and title cards. About 23 MB, downloaded from the TournamentStreamHelper repository.', action: 'art', label: 'Download' },
      vm ? vmixOverlayItem()
        : S.overlay && S.overlay.installed
          ? { state: 'ok', title: 'Stream overlay', text: `In OBS scene ${S.overlay.inScenes.join(', ')} as the source "TEC Overlay".${S.overlay.currentScene && !S.overlay.inScenes.includes(S.overlay.currentScene) ? ` OBS is showing "${S.overlay.currentScene}" right now.` : ''}` }
          : { state: 'opt', title: 'Stream overlay (optional)', text: o.connected ? 'Player names, round and wins drawn over the gameplay scene. Adds a Browser Source called "TEC Overlay" to OBS.' : 'Player names, round and wins over the gameplay scene. Available once OBS is connected.', action: o.connected ? 'overlay' : undefined, label: 'Add to OBS' },
      t && t.ok
        ? { state: 'ok', title: 'Test recording', text: testRecText(t) }
        : t && !t.running && t.error
          ? { state: 'warn', title: 'Test recording', text: testRecText(t), action: 'test', label: 'Run again' }
          : { state: 'opt', title: 'Test recording', text: t && t.running ? testRecText(t) : `Records five seconds, checks the file, removes it. Needs ${o.name} connected.`, action: 'test', label: t && t.running ? 'Running...' : 'Run test' },
    ];
  }
  function vmixOverlayItem() {
    const ov = S.overlay || {};
    if (ov.installed && ov.channel) return { state: 'ok', title: 'Stream overlay', text: `Live on vMix overlay channel ${ov.channel} as the Browser input "TEC Overlay".` };
    if (ov.installed) return { state: 'warn', title: 'Stream overlay', text: 'The Browser input "TEC Overlay" is in vMix but not on an overlay channel, so it is off air.', action: 'overlay', label: 'Put it on air' };
    return S.sw.connected
      ? { state: 'opt', title: 'Stream overlay (optional)', text: 'Player names, round and wins over the program output. Adds a Browser input called "TEC Overlay" to vMix on the first free overlay channel.', action: 'overlay', label: 'Add to vMix' }
      : { state: 'opt', title: 'Stream overlay (optional)', text: 'Player names, round and wins over the program output. Available once vMix is connected.' };
  }
  function renderSetup() {
    if (!S) return;
    $('#setup-list').innerHTML = setupItems().map((it) => `<li><span class="dot ${it.state === 'opt' ? '' : it.state}"></span><div class="body"><b>${esc(it.title)}</b><span>${esc(it.text)}</span></div>${it.action ? `<button type="button" class="small" data-setup="${it.action}"${it.label === 'Running...' ? ' disabled' : ''}>${esc(it.label)}</button>` : ''}</li>`).join('');
  }
  $('#setup-list').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-setup]');
    if (!b) return;
    if (b.dataset.setup === 'settings') { $('#setup').hidden = true; openSettings(); }
    else if (b.dataset.setup === 'art') { try { await api('POST', '/api/art/download', { pack: 'portrait' }); toast('Downloading the portrait pack.'); } catch (e) { toast(e.message, { error: true }); } }
    else if (b.dataset.setup === 'test') runTestRecording();
    else if (b.dataset.setup === 'overlay') { try { const r = await api('POST', '/api/overlay/install', { scene: '' }); toast(overlayInstalledMessage(r), { sticky: true }); renderSetup(); } catch (e) { toast(e.message, { error: true }); } }
  });
  $('#setup-refresh').addEventListener('click', renderSetup);
  $('#setup-settings').addEventListener('click', () => { $('#setup').hidden = true; openSettings(); });
  $('#setup-close').addEventListener('click', async () => {
    $('#setup').hidden = true;
    const dismissed = $('#setup-dismiss').checked;
    if (S && !!(S.config.setup && S.config.setup.dismissed) !== dismissed) {
      try { await api('PUT', '/api/config', { setup: { dismissed } }); } catch (e) { toast(e.message, { error: true }); }
    }
  });
  $('#btn-setup').addEventListener('click', () => { $('#settings').hidden = true; openSetup(); });
  async function loadSources(selected) {
    const sel = $('#settings-form').elements['detect.source'];
    if (!sel) return;
    let data = { inputs: [], scenes: [] };
    try { data = await api('GET', '/api/detect/sources'); } catch { /* app offline */ }
    const program = isVmix() ? 'Program output (vMix output snapshot)' : 'Program output (whatever OBS is showing)';
    const opts = [['', program], ...data.inputs.map((i) => [i.name, `${i.name} (${i.kind})`]), ...data.scenes.map((s) => [s, `Scene: ${s}`])];
    if (selected && !opts.some((o) => o[0] === selected)) opts.push([selected, selected]);
    sel.innerHTML = opts.map(([v, label]) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(label)}</option>`).join('');
  }
  $('#btn-settings').addEventListener('click', () => { if (S) openSettings(); });
  async function refreshOverlayStatus() {
    const out = $('#overlay-status');
    const sel = $('#overlay-scene');
    try {
      const st = await api('GET', '/api/overlay/status');
      if (isVmix()) {
        out.textContent = st.installed
          ? (st.channel ? `In vMix as input ${st.number} "TEC Overlay", live on overlay channel ${st.channel}.` : `In vMix as input ${st.number} "TEC Overlay", but not on an overlay channel. Press "Add overlay to vMix" to put it back on air.`)
          : (S.sw.connected ? 'Not in vMix yet. "Add overlay to vMix" adds a Browser input and puts it on the overlay channel picked here.' : 'Connect vMix first.');
        return;
      }
      const preferred = (S && S.config.overlay && S.config.overlay.scene) || st.inScenes[0] || st.scenes.find((s) => /gameplay|game/i.test(s)) || st.scenes[0] || '';
      sel.innerHTML = st.scenes.map((s) => `<option value="${esc(s)}"${s === preferred ? ' selected' : ''}>${esc(s)}</option>`).join('') || '<option value="">(connect OBS to list scenes)</option>';
      const o = (S && S.overlay) || {};
      const showing = st.installed && o.currentScene && !st.inScenes.includes(o.currentScene) ? ` OBS is showing "${o.currentScene}" right now; switch to ${st.inScenes.join(' or ')} to see it.` : '';
      out.textContent = st.installed ? `Installed in: ${st.inScenes.join(', ')} (source "TEC Overlay", top of the scene).${showing}` : 'Not in OBS yet. Press "Add overlay to OBS" while OBS is connected; it lands at the top of the chosen scene.';
    } catch (e) { out.textContent = e.message; }
  }
  $('#btn-overlay-add').addEventListener('click', async () => {
    try {
      const r = await api('POST', '/api/overlay/install', isVmix() ? { channel: Number($('#settings-form').elements['vmix.overlayChannel'].value) || 0 } : { scene: $('#overlay-scene').value });
      toast(overlayInstalledMessage(r), { sticky: true });
      refreshOverlayStatus();
    } catch (e) { toast(e.message, { error: true }); }
  });
  function overlayInstalledMessage(r) {
    if (r.vmix) return `Overlay added to vMix as input ${r.number} "TEC Overlay" and put on overlay channel ${r.channel}, over the program output. Sample names show for 30 seconds, then the plates follow the selected set.`;
    const where = r.visibleNow
      ? 'It is on screen in OBS now'
      : `OBS is showing "${r.currentScene}" right now, so switch OBS to "${r.scene}" to see it`;
    return `Overlay added to OBS scene "${r.scene}" as the top source "TEC Overlay". ${where}. Sample names show for 30 seconds, then the plates follow the selected set.`;
  }
  $('#chip-overlay').addEventListener('click', () => {
    if (!S) return;
    openSettings();
    setTimeout(() => $('#btn-overlay-add').scrollIntoView({ block: 'center' }), 60);
  });
  $('#btn-overlay-remove').addEventListener('click', async () => {
    try { await api('POST', '/api/overlay/remove'); toast(`Overlay removed from ${S.sw.name}.`); refreshOverlayStatus(); } catch (e) { toast(e.message, { error: true }); }
  });
  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('.score-btn');
    if (!b) return;
    try { await api('POST', '/api/current/score', { side: Number(b.dataset.score), delta: Number(b.dataset.delta) }); } catch (e) { toast(e.message, { error: true }); }
  });
  document.addEventListener('click', async (ev) => {
    const p = ev.target.closest('.pip');
    if (!p) return;
    const side = Number(p.dataset.winSide);
    const n = Number(p.dataset.winN);
    const cur = Number(S && S.current[`wins${side}`]) || 0;
    try { await api('PATCH', '/api/current', { [`wins${side}`]: cur === n ? n - 1 : n }); } catch (e) { toast(e.message, { error: true }); }
  });
  $('#best-of').addEventListener('change', async () => {
    try { await api('PATCH', '/api/current', { bestOf: Number($('#best-of').value) }); } catch (e) { toast(e.message, { error: true }); }
  });
  $('#btn-unmark').addEventListener('click', async () => {
    const setId = S && S.current.setId;
    if (!setId) return;
    try {
      const r = await api('POST', '/api/recorded/toggle', { setId });
      toast(r.recorded ? 'Set marked as recorded.' : 'Recorded mark cleared. The earlier file is still in the recordings folder.');
    } catch (e) { toast(e.message, { error: true }); }
  });
  $('#btn-import').addEventListener('click', async () => {
    const url = $('#import-url').value.trim();
    const out = $('#import-status');
    if (!url) { out.textContent = 'Paste the tournament URL first.'; return; }
    out.textContent = 'Looking up the tournament…';
    try {
      const r = await api('POST', '/api/startgg/import', { url });
      $('#settings-form').elements['startgg.eventUrls'].value = (r.eventUrls || []).join('\n');
      out.innerHTML = `<b>${esc(r.tournament)}</b>: added ${r.added.length} event${r.added.length === 1 ? '' : 's'}${r.added.length ? ` (${esc(r.added.join('; '))})` : ''}.`
        + (r.skipped.length ? `<br>Skipped: ${esc(r.skipped.join('; '))}` : '');
    } catch (e) { out.textContent = e.message; }
  });
  function showHowto(which) {
    $('#howto').hidden = false;
    $('#howto-quick').hidden = which !== 'quick';
    $('#howto-full').hidden = which !== 'full';
    for (const t of document.querySelectorAll('#howto .tab[data-howto]')) t.classList.toggle('active', t.dataset.howto === which);
  }
  $('#btn-howto').addEventListener('click', () => showHowto('quick'));
  $('#howto-close').addEventListener('click', () => { $('#howto').hidden = true; });
  $('#howto').addEventListener('click', (ev) => {
    const pick = ev.target.closest('[data-howto]');
    if (pick) { showHowto(pick.dataset.howto); return; }
    if (ev.target === $('#howto')) $('#howto').hidden = true;
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' || ev.key === 'Esc') { $('#howto').hidden = true; $('#settings').hidden = true; }
  });
  $('#settings-close').addEventListener('click', () => { $('#settings').hidden = true; });
  $('#settings').addEventListener('click', (ev) => { if (ev.target === $('#settings')) $('#settings').hidden = true; });
  $('#settings-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = {};
    for (const el of $('#settings-form').elements) {
      if (!el.name) continue;
      const parts = el.name.split('.');
      let o = body;
      for (let i = 0; i < parts.length - 1; i += 1) o = o[parts[i]] = o[parts[i]] || {};
      o[parts[parts.length - 1]] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    }
    try {
      await api('PUT', '/api/config', body);
      toast('Settings saved');
      $('#settings').hidden = true;
    } catch (e) { toast(e.message, { error: true }); }
  });

  // ---------- misc controls ----------
  document.addEventListener('click', (ev) => {
    const t = ev.target.closest('.evtab');
    if (!t) return;
    if (t.dataset.pool !== undefined) bracketPool = t.dataset.pool || '';
    else bracketEvent = t.dataset.event || '';
    renderBracket(true);
  });
  $('#current-game').addEventListener('change', async () => {
    await flushPatch();
    try { await api('PATCH', '/api/current', { game: $('#current-game').value }); } catch (e) { toast(e.message, { error: true }); }
  });
  for (const tab of document.querySelectorAll('.tab[data-tab]')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.tab[data-tab]')) t.classList.toggle('active', t === tab);
      $('#tab-bracket').hidden = tab.dataset.tab !== 'bracket';
      $('#tab-manual').hidden = tab.dataset.tab !== 'manual';
    });
  }
  for (const id of ['bracket-search', 'opt-hide-done', 'opt-show-tbd']) $(`#${id}`).addEventListener('input', () => renderBracket(false));
  $('#btn-sync').addEventListener('click', async () => {
    try { await api('POST', '/api/startgg/sync'); } catch (e) { toast(e.message, { error: true }); }
  });
  $('#btn-copy-all').addEventListener('click', async () => {
    const rows = (S.log || []).filter((e) => e.status === 'saved').slice().reverse().map(bibleRow);
    if (!rows.length) return toast('Nothing saved yet');
    const ok = await copyText(rows.join('\n'));
    toast(ok ? `Copied ${rows.length} worksheet row${rows.length === 1 ? '' : 's'}. Paste into the worksheet.` : 'Could not copy to the clipboard', { error: !ok });
  });
  $('#btn-open-folder').addEventListener('click', async () => {
    try { const r = await api('POST', '/api/open-folder'); toast(`Opened ${r.dir}`); } catch (e) { toast(e.message, { error: true }); }
  });
  $('#round-list').innerHTML = ROUND_SUGGESTIONS.map((r) => `<option value="${esc(r)}">`).join('');

  // ---------- boot ----------
  fetch('/api/fighters').then((r) => r.json()).then((list) => { fighters = list; }).catch(() => {});
  connect();
  setInterval(() => { if (S) { renderChips(); renderRecord(); } }, 1000);
})();
