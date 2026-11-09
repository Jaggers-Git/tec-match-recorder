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
    es.addEventListener('state', (ev) => {
      const wasOffline = !appOnline;
      S = JSON.parse(ev.data);
      appOnline = true;
      // Back after a restart: the picture streams ended with the old process, so open them again.
      if (wasOffline) restartLive();
      render();
    });
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
    applyMode();
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
    renderScreens();
    renderLive();
    renderReplay();
    renderLogPanel();
  }
  // Per-device conveniences (picture hidden, log folded); a private window simply forgets them.
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  };

  // ---------- dashboard mode: Record or Broadcast (one choice for the whole station, saved in config) ----------
  const modeNow = () => (S && S.mode === 'broadcast' ? 'broadcast' : 'record');
  function applyMode() {
    const mode = modeNow();
    if (document.documentElement.dataset.mode !== mode) document.documentElement.dataset.mode = mode;
    for (const b of document.querySelectorAll('.mode-switch [data-mode]')) b.classList.toggle('active', b.dataset.mode === mode);
  }
  document.querySelector('.mode-switch').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-mode]');
    if (!b || !S || b.dataset.mode === modeNow()) return;
    document.documentElement.dataset.mode = b.dataset.mode;
    try { await api('PUT', '/api/config', { mode: b.dataset.mode }); } catch (e) { toast(e.message, { error: true }); applyMode(); }
  });

  // ---------- live output picture (Broadcast mode) ----------
  // Each picture fetches the newest frame, waits the server's frame interval, and fetches again. Short
  // requests, never a stream held open: a browser allows six connections to the recorder, and two
  // dashboard tabs with open picture streams would leave none for the buttons. The loop only runs while
  // Broadcast mode is showing on a visible tab, so OBS does no work for pages that are not looking.
  const LIVE_HIDE_KEY = 'tec.liveHidden';
  const liveLoop = { program: { on: false, busy: false, timer: null, seq: '', url: '' }, preview: { on: false, busy: false, timer: null, seq: '', url: '' } };
  $('#live-hide').checked = store.get(LIVE_HIDE_KEY) === '1';
  $('#live-hide').addEventListener('change', () => { store.set(LIVE_HIDE_KEY, $('#live-hide').checked ? '1' : '0'); renderLive(); });
  document.addEventListener('visibilitychange', () => renderLive());
  function setLive(which, on) {
    const L = liveLoop[which];
    if (on === L.on) return;
    L.on = on;
    clearTimeout(L.timer);
    if (on) pullFrame(which);
    else if (L.url) { $(`#live-${which}`).removeAttribute('src'); URL.revokeObjectURL(L.url); L.url = ''; L.seq = ''; }
  }
  async function pullFrame(which) {
    const L = liveLoop[which];
    if (!L.on || L.busy) return;
    L.busy = true;
    const started = Date.now();
    let wait = 1000;
    try {
      const res = await fetch(`/api/live.jpg?which=${which}&after=${encodeURIComponent(L.seq)}`, { cache: 'no-store' });
      wait = Number(res.headers.get('X-Interval')) || 500;
      if (res.status === 200 && L.on) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const old = L.url;
        L.url = url;
        L.seq = res.headers.get('X-Frame') || '';
        $(`#live-${which}`).src = url;
        if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
      } else if (res.status === 204 && res.headers.get('X-Frame') === '0') wait = 1000;
    } catch { wait = 2000; }
    L.busy = false;
    if (L.on) L.timer = setTimeout(() => pullFrame(which), Math.max(40, wait - (Date.now() - started)));
  }
  // Back after a restart: frame numbers start again from 1, so forget the last one.
  function restartLive() { for (const L of Object.values(liveLoop)) L.seq = ''; }
  function renderLive() {
    if (!S) return;
    const o = S.sw;
    const vm = isVmix();
    const hidden = $('#live-hide').checked;
    const canShow = o.connected && o.snapshots;
    const hasPreview = vm ? !!o.preview : !!o.studioMode;
    const want = modeNow() === 'broadcast' && !hidden && !document.hidden && canShow;
    setLive('program', want);
    setLive('preview', want && hasPreview);
    $('#live-preview-wrap').hidden = !hasPreview;
    $('#live-views').classList.toggle('single', !hasPreview);
    $('#live-program-name').textContent = o.program || '';
    $('#live-preview-name').textContent = o.preview || '';
    const off = !o.connected ? `${o.name} is not connected` : !o.snapshots ? 'vMix runs on another PC, so its picture cannot be shown here' : hidden ? 'Picture hidden on this device' : '';
    for (const w of ['program', 'preview']) { const el = $(`#live-${w}-off`); el.hidden = !off; el.textContent = off; }
    const err = S.live && S.live.error;
    const toPreview = (S.config.scenes || {}).to !== 'program';
    $('#live-status').textContent = err ? `Picture: ${err}`
      : !canShow ? ''
        : !vm && !o.studioMode && toPreview ? 'Studio Mode is off in OBS, so the scene buttons have no Preview to load'
          : vm ? 'About one frame a second, no sound' : 'About a quarter second behind, no sound';
  }

  // ---------- instant replay ----------
  let replaySpeed = null;   // this device's pick until the server has it
  let replayKey = '';
  let checkId = '';         // the clip playing in the panel's own player
  const speedNow = () => replaySpeed ?? ((S && S.replay && S.replay.speed) || 50);
  function replayWho(e) { return e.p1 || e.p2 ? `${e.p1 || '?'} vs ${e.p2 || '?'}` : 'No set picked'; }
  function replayItem(e, r) {
    const d = new Date(e.ts);
    const when = `${fmtClock(e.ts)}:${pad(d.getSeconds())}`;
    // No length here: a clip starts on a keyframe, so it can run a few seconds off the setting.
    const meta = [e.set ? `Set ${e.set}` : '', e.round].filter(Boolean).join(', ');
    const note = e.status === 'saving' ? 'saving…' : e.status === 'error' ? e.error : e.exporting ? 'exporting from vMix…' : e.error || '';
    const canCheck = e.status === 'saved' && !e.vmixOnly && !!e.filename;
    const canAir = r.sw === 'obs' ? e.status === 'saved' : !!e.vmixLast;
    const airTitle = canAir ? `Play on stream at the chosen speed (${r.sw === 'obs' ? 'to Preview or Program, as the scene buttons do' : 'vMix plays its newest event to the output'})` : r.sw === 'obs' ? 'Not ready yet' : 'Play older events from the Replay input in vMix';
    const cls = [r.playing && r.playing.id === e.id ? 'playing' : '', checkId === e.id ? 'checking' : ''].filter(Boolean).join(' ');
    return `<li class="${cls}">
      <button type="button" class="star${e.star ? ' on' : ''}" data-replay-star="${esc(e.id)}" title="${e.star ? 'Unstar' : 'Star this clip'}">${e.star ? '★' : '☆'}</button>
      <div class="info"><b>${esc(replayWho(e))}</b><span class="muted">${esc(when)}${meta ? `, ${esc(meta)}` : ''}</span>${note ? `<span class="${e.status === 'error' ? 'err' : 'muted'}">${esc(note)}</span>` : ''}</div>
      <div class="acts">
        ${canCheck ? `<button type="button" class="small" data-replay-check="${esc(e.id)}" title="Play it here at the chosen speed, off air">▶</button>` : ''}
        <button type="button" class="small" data-replay-air="${esc(e.id)}"${canAir ? '' : ' disabled'} title="${esc(airTitle)}">On air</button>
        <button type="button" class="small" data-replay-remove="${esc(e.id)}" title="Remove from the list (the file stays in the Replays folder)">✕</button>
      </div>
    </li>`;
  }
  function renderReplay() {
    const r = S && S.replay;
    if (!r) return;
    const vm = r.sw === 'vmix';
    if (replaySpeed != null && r.speed === replaySpeed) replaySpeed = null;
    const ready = r.connected && r.available && r.active;
    const btn = $('#btn-replay');
    btn.disabled = !ready || r.saving;
    btn.classList.toggle('saving', !!r.saving);
    $('#replay-btn-sub').textContent = r.saving ? 'saving…' : `save the last ${r.seconds} seconds`;
    let status;
    if (!r.connected) status = `Waiting for ${S.sw.name}`;
    else if (r.available === false) status = vm ? 'Not available in this vMix' : 'Replay buffer is off in OBS';
    else if (r.available == null) status = 'Checking…';
    else if (!r.active) status = vm ? 'vMix replay is not recording' : 'Replay buffer stopped';
    else status = vm ? `vMix replay recording, ${r.seconds} s clips` : `Buffer running, last ${r.seconds} s`;
    if (r.playing) status = `${r.playing.onAir ? 'On air' : 'Cued in Preview'} at ${r.playing.speed}%`;
    $('#replay-status').textContent = status;
    const help = !r.connected ? '' : r.available === false ? r.reason : r.lastError || '';
    $('#replay-help').hidden = !help;
    $('#replay-help').textContent = help;
    const bb = $('#btn-replay-buffer');
    bb.hidden = !(r.connected && r.available);
    bb.textContent = r.active ? (vm ? 'Stop replay recording' : 'Stop buffer') : (vm ? 'Start replay recording' : 'Start buffer');
    const sp = speedNow();
    const slider = $('#replay-speed');
    if (document.activeElement !== slider) slider.value = String(sp);
    $('#replay-speed-num').textContent = `${sp}%`;
    for (const b of document.querySelectorAll('#replay-speeds [data-speed]')) b.classList.toggle('active', Number(b.dataset.speed) === sp);
    const newest = r.events.find((e) => (vm ? e.vmixLast : e.status === 'saved'));
    $('#btn-replay-air').disabled = !r.connected || !newest;
    const back = $('#btn-replay-back');
    back.hidden = !(r.sw === 'obs' && r.returnTo && S.sw.program === r.scene.name);
    back.textContent = `Back to ${r.returnTo || 'live'}`;
    const key = JSON.stringify([r.events.map((e) => [e.id, e.status, e.star, e.filename, e.error, e.exporting, e.vmixLast, e.p1, e.p2]), r.playing && r.playing.id, checkId, r.sw]);
    if (key !== replayKey) {
      replayKey = key;
      $('#replay-list').innerHTML = r.events.length
        ? r.events.map((e) => replayItem(e, r)).join('')
        : `<li class="empty muted">No replays yet. ${ready ? 'Press REPLAY after a big moment.' : ''}</li>`;
    }
  }
  async function saveReplay() {
    try {
      const r = await api('POST', '/api/replay/save');
      if (modeNow() === 'record') toast(`Clip saved: ${r.event.base}. It goes in the Replays folder next to the recordings.`);
    } catch (e) { toast(e.message, { error: true }); }
  }
  $('#btn-replay').addEventListener('click', saveReplay);
  $('#btn-clip').addEventListener('click', saveReplay);
  async function setSpeed(n) {
    replaySpeed = n;
    renderReplay();
    const v = $('#replay-video');
    v.playbackRate = n / 100;
    try { await api('POST', '/api/replay/speed', { speed: n }); } catch (e) { replaySpeed = null; toast(e.message, { error: true }); }
  }
  $('#replay-speeds').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-speed]');
    if (b) setSpeed(Number(b.dataset.speed));
  });
  $('#replay-speed').addEventListener('input', () => {
    const n = Number($('#replay-speed').value);
    $('#replay-speed-num').textContent = `${n}%`;
    $('#replay-video').playbackRate = n / 100;
  });
  $('#replay-speed').addEventListener('change', () => setSpeed(Number($('#replay-speed').value)));
  async function playOnAir(id) {
    try {
      const r = await api('POST', '/api/replay/play', { id, speed: speedNow() });
      if (r.to === 'preview') toast('The replay is in Preview. Press Transition to take it live; it starts from the top.');
    } catch (e) { toast(e.message, { error: true }); }
  }
  $('#btn-replay-air').addEventListener('click', () => playOnAir(''));
  $('#btn-replay-back').addEventListener('click', async () => {
    try { await api('POST', '/api/replay/back'); } catch (e) { toast(e.message, { error: true }); }
  });
  $('#btn-replay-buffer').addEventListener('click', async () => {
    try { await api('POST', '/api/replay/buffer', { on: !(S.replay && S.replay.active) }); } catch (e) { toast(e.message, { error: true }); }
  });
  $('#btn-replay-folder').addEventListener('click', async () => {
    try { const r = await api('POST', '/api/replay/open-folder'); toast(`Opened ${r.dir}`); } catch (e) { toast(e.message, { error: true }); }
  });
  // The panel's own player: check a clip at the chosen speed without putting it on stream.
  function checkClip(id) {
    const e = ((S && S.replay && S.replay.events) || []).find((x) => x.id === id);
    if (!e) return;
    const v = $('#replay-video');
    checkId = id;
    $('#replay-player').hidden = false;
    $('#replay-player-name').textContent = `${replayWho(e)}, ${speedNow()}%`;
    v.src = `/api/replay/clip?id=${encodeURIComponent(id)}`;
    v.defaultPlaybackRate = speedNow() / 100;
    v.playbackRate = speedNow() / 100;
    v.play().catch(() => {});
    replayKey = '';
    renderReplay();
  }
  $('#replay-video').addEventListener('loadedmetadata', () => { $('#replay-video').playbackRate = speedNow() / 100; });
  $('#replay-video').addEventListener('error', () => {
    if (!checkId) return;
    toast('This browser cannot play that clip. MKV files often will not play in a browser; record in Hybrid MP4 in OBS (Settings, Output, Recording Format).', { error: true });
  });
  $('#btn-player-close').addEventListener('click', () => {
    const v = $('#replay-video');
    v.pause();
    v.removeAttribute('src');
    v.load();
    checkId = '';
    $('#replay-player').hidden = true;
    replayKey = '';
    renderReplay();
  });
  $('#replay-list').addEventListener('click', async (ev) => {
    const star = ev.target.closest('[data-replay-star]');
    if (star) { try { await api('POST', '/api/replay/star', { id: star.dataset.replayStar }); } catch (e) { toast(e.message, { error: true }); } return; }
    const check = ev.target.closest('[data-replay-check]');
    if (check) { checkClip(check.dataset.replayCheck); return; }
    const air = ev.target.closest('[data-replay-air]');
    if (air) { playOnAir(air.dataset.replayAir); return; }
    const rm = ev.target.closest('[data-replay-remove]');
    if (rm) { try { await api('POST', '/api/replay/remove', { id: rm.dataset.replayRemove }); } catch (e) { toast(e.message, { error: true }); } }
  });

  // ---------- session log: folded by default in Broadcast mode, remembered per device and mode ----------
  const logKey = () => `tec.logHidden.${modeNow()}`;
  function logHidden() { const v = store.get(logKey()); return v === null ? modeNow() === 'broadcast' : v === '1'; }
  function renderLogPanel() {
    const hidden = logHidden();
    $('#log-panel').classList.toggle('collapsed', hidden);
    $('#btn-log-toggle').textContent = hidden ? 'Show' : 'Hide';
    const n = (S && S.log ? S.log.length : 0);
    $('#log-count').textContent = hidden ? `${n} set${n === 1 ? '' : 's'} recorded` : '';
  }
  $('#btn-log-toggle').addEventListener('click', () => { store.set(logKey(), logHidden() ? '0' : '1'); renderLogPanel(); });
  // ---------- stream screens (message, caster cards, scene buttons) ----------
  const SCR_FIELDS = [['#scr-message', (s) => s.message], ['#scr-c1-name', (s) => s.casters[0].name], ['#scr-c1-handle', (s) => s.casters[0].handle], ['#scr-c2-name', (s) => s.casters[1].name], ['#scr-c2-handle', (s) => s.casters[1].handle]];
  let sceneKey = '';
  function renderScreens() {
    const s = S.screens;
    if (!s) return;
    // Leave the box being typed in alone; the others follow the server (another device may be editing).
    for (const [sel, get] of SCR_FIELDS) if (document.activeElement !== $(sel) && $(sel).value !== get(s)) $(sel).value = get(s);
    const c = S.config.scenes || {};
    const gameplay = c.gameplay || (S.config.overlay && S.config.overlay.scene) || '';
    const rs = S.replay && S.replay.scene;
    const list = [gameplay ? ['Gameplay', gameplay] : null, ...((S.screenScenes || []).map((n) => [n.replace(/^MM /, ''), n])), rs && rs.installed ? ['Replay', rs.name] : null].filter(Boolean);
    const preview = c.to !== 'program';
    const live = S.sw.program || '';
    const cued = S.sw.studioMode ? S.sw.preview || '' : '';
    const key = [S.sw.connected, preview, live, cued, ...list.flat()].join('|');
    if (key === sceneKey) return;
    sceneKey = key;
    // Preview mode: the scene buttons load Preview and Transition takes it live; Program mode cuts at once.
    // The scene on Program is outlined red and the one in Preview green, as in OBS.
    const state = (name) => (name === live ? ' on-program' : name === cued ? ' on-preview' : '');
    const where = (name) => (name === live ? ' (on air now)' : name === cued ? ' (in Preview now)' : '');
    $('#scene-buttons').innerHTML = S.sw.connected
      ? (preview ? '<span class="muted" style="align-self:center">To Preview:</span>' : '')
        + list.map(([label, name]) => `<button class="small${state(name)}" type="button" data-scene="${esc(name)}" title="${preview ? 'Load' : 'Cut'} &quot;${esc(name)}&quot; ${preview ? `into ${esc(S.sw.name)}'s Preview` : `to ${esc(S.sw.name)}'s Program`}${where(name)}">${esc(label)}</button>`).join('')
        + (preview ? '<button class="small primary" type="button" data-transition title="Take Preview live with the current transition">Transition ▶</button>' : '')
      : '';
  }
  let scrTimer = null;
  function sendScreens() {
    clearTimeout(scrTimer);
    scrTimer = setTimeout(async () => {
      const v = (sel) => $(sel).value;
      try {
        await api('PATCH', '/api/screens', {
          message: v('#scr-message'),
          casters: [{ name: v('#scr-c1-name'), handle: v('#scr-c1-handle') }, { name: v('#scr-c2-name'), handle: v('#scr-c2-handle') }],
        });
      } catch (e) { toast(e.message, { error: true }); }
    }, 350);
  }
  for (const [sel] of SCR_FIELDS) $(sel).addEventListener('input', sendScreens);
  $('#scene-buttons').addEventListener('click', async (ev) => {
    if (ev.target.closest('[data-transition]')) {
      if (S.rec && S.rec.active && !confirm('A set is recording. Taking Preview live puts it in the VOD. Transition anyway?')) return;
      try { await api('POST', '/api/scenes/transition'); } catch (e) { toast(e.message, { error: true }); }
      return;
    }
    const b = ev.target.closest('[data-scene]');
    if (!b) return;
    const program = (S.config.scenes || {}).to === 'program';
    if (program && S.rec && S.rec.active && !/gameplay/i.test(b.textContent) && !confirm(`A set is recording. Cutting to "${b.dataset.scene}" puts it in the VOD. Cut anyway?`)) return;
    try { await api('POST', '/api/scenes/switch', { scene: b.dataset.scene }); } catch (e) { toast(e.message, { error: true }); }
  });
  // ---------- branding (picked in Settings; /theme.js applies it before the first paint) ----------
  const TEC_MARK = $('#brand-mark').innerHTML;
  const TEC_ICON = document.querySelector('link[rel="icon"]').href;
  // Stand-in for a theme whose logo has not been saved yet.
  const TT_EMBLEM = '<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46" fill="#1a0d10" stroke="#F2B53A" stroke-width="6"/><circle cx="50" cy="50" r="36" fill="#6D2E3F"/><text x="50" y="62" text-anchor="middle" font-family="Urban Constructed, Oswald, Arial Narrow, sans-serif" font-weight="700" font-size="32" fill="#FCE319">TT</text></svg>';
  // Metroplex Major's crown ships with the app, so that theme never needs a saved logo.
  const MM_CROWN = '<svg viewBox="-6 -38 190 128" aria-hidden="true"><g fill="#F0B40D"><polygon points="0,9 9,0 22,0 50,28 78,0 89,-13 100,0 128,28 156,0 169,0 178,9 178,69 169,78 156,78 156,31 128,59 100,31 100,78 78,78 78,31 50,59 22,31 22,78 9,78 0,69"/><polygon points="15.5,-15 21.5,-9 15.5,-3 9.5,-9"/><polygon points="89,-32.5 96.5,-25 89,-17.5 81.5,-25"/><polygon points="162.5,-15 168.5,-9 162.5,-3 156.5,-9"/></g></svg>';
  const MM_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="-6 -38 190 128"><polygon fill="#F0B40D" points="0,9 9,0 22,0 50,28 78,0 89,-13 100,0 128,28 156,0 169,0 178,9 178,69 169,78 156,78 156,31 128,59 100,31 100,78 78,78 78,31 50,59 22,31 22,78 9,78 0,69"/></svg>')}`;
  let brandKey = '';
  function applyBranding() {
    const b = S.branding || { theme: 'tec' };
    const mm = b.theme === 'mm';
    // In promo mode the header counts down to the Major.
    const org = mm && b.mm && b.mm.mode !== 'event' && window.MM.daysTo(b.mm.start) > 0
      ? `Metroplex Major ◆ ${window.MM.daysTo(b.mm.start)} days out` : b.org || 'Texas Esports Collective';
    const key = [b.theme, b.logo, b.smashOnly, org].join('|');
    if (key === brandKey) return;
    brandKey = key;
    const tec = b.theme === 'tec';
    document.documentElement.dataset.theme = b.theme;
    document.documentElement.classList.toggle('smash-only', !!b.smashOnly);
    $('#brand-mark').innerHTML = tec ? TEC_MARK : mm ? MM_CROWN : b.logo ? `<img src="${esc(b.logo)}" alt="">` : TT_EMBLEM;
    $('#brand-org').innerHTML = window.MM.gems(org);
    document.title = tec ? 'TEC Match Recorder' : `${b.name} · Match Recorder`;
    document.querySelector('link[rel="icon"]').href = mm ? MM_ICON : !tec && b.logo ? b.logo : TEC_ICON;
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
      st.textContent = connected ? (modeNow() === 'broadcast' ? 'Ready to record the set.' : 'Pick a set or enter the players, then start. Names can still be fixed while recording.') : '';
    }
    // Record mode's highlight clip: the same save as REPLAY, without the on-air controls.
    const r = S.replay;
    const clip = $('#btn-clip');
    clip.hidden = !(r && r.connected && r.available && r.active);
    clip.disabled = !!(r && r.saving);
    clip.textContent = r && r.saving ? 'Saving clip…' : `Save clip (last ${r ? r.seconds : 15} s)`;
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
    const mmCfg = (c.branding && c.branding.mm) || {};
    set('branding.mm.mode', mmCfg.mode === 'event' ? 'event' : 'promo');
    set('branding.mm.corners', mmCfg.corners !== false);
    set('branding.mm.ticker', mmCfg.ticker || '');
    setTickerPlaceholder();
    set('smashOnly', c.smashOnly);
    f.dataset.theme = f.elements['branding.theme'].value;
    set('event.name', c.event.name);
    setEventNameHint();
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
    set('scenes.autoSwitch', c.scenes && c.scenes.autoSwitch);
    set('scenes.to', c.scenes && c.scenes.to === 'program' ? 'program' : 'preview');
    loadSceneChoices(c.scenes || {});
    const rp = c.replay || {};
    set('replay.enabled', rp.enabled !== false);
    set('replay.seconds', rp.seconds || 15);
    set('replay.autoReturn', rp.autoReturn !== false);
    set('replay.audio', !!rp.audio);
    renderReplaySceneStatus();
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
  // A start.gg link pasted as the event name would end up in every title; point it at the start.gg box instead.
  function setEventNameHint() {
    $('#event-name-hint').hidden = !/^https?:\/\/|start\.gg\//i.test($('#settings-form').elements['event.name'].value.trim());
  }
  $('#settings-form').elements['event.name'].addEventListener('input', setEventNameHint);
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
  // A blank ticker box uses the defaults for the picked mode; show them as the placeholder.
  function setTickerPlaceholder() {
    const d = (S && S.branding && S.branding.mm && S.branding.mm.defaults) || {};
    $('#mm-ticker').placeholder = (d[$('#mm-mode').value] || []).join('\n');
  }
  $('#mm-mode').addEventListener('change', setTickerPlaceholder);
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
      replaySetupItem(),
      t && t.ok
        ? { state: 'ok', title: 'Test recording', text: testRecText(t) }
        : t && !t.running && t.error
          ? { state: 'warn', title: 'Test recording', text: testRecText(t), action: 'test', label: 'Run again' }
          : { state: 'opt', title: 'Test recording', text: t && t.running ? testRecText(t) : `Records five seconds, checks the file, removes it. Needs ${o.name} connected.`, action: 'test', label: t && t.running ? 'Running...' : 'Run test' },
    ];
  }
  function replaySetupItem() {
    const r = S.replay || {};
    const vm = isVmix();
    const title = 'Instant replay';
    if (!S.sw.connected) return { state: 'opt', title: `${title} (optional)`, text: `Saves the last ${r.seconds || 15} seconds on a button press, for slow motion on stream or highlight clips. Available once ${S.sw.name} is connected.` };
    if (r.available === false) return { state: 'opt', title: `${title} (optional)`, text: r.reason };
    if (r.available == null) return { state: 'opt', title: `${title} (optional)`, text: `Asking ${S.sw.name}…` };
    if (!r.active) return { state: 'warn', title, text: vm ? 'The vMix Replay input is not recording, so REPLAY has nothing to mark.' : 'The OBS replay buffer is stopped, so REPLAY has nothing to save.', action: 'replay-start', label: vm ? 'Start recording' : 'Start buffer' };
    if (vm) return { state: 'ok', title, text: `vMix replay recording; REPLAY marks the last ${r.seconds} seconds.` };
    if (!r.scene.installed) return { state: 'ok', title, text: `OBS replay buffer running, last ${r.seconds} seconds. The "TEC Replay" scene for slow motion on stream is added on the first Play, or now.`, action: 'replay-scene', label: 'Add replay scene' };
    return { state: 'ok', title, text: `OBS replay buffer running, last ${r.seconds} seconds; scene "${r.scene.name}" ready.` };
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
    else if (b.dataset.setup === 'replay-start') { try { await api('POST', '/api/replay/buffer', { on: true }); } catch (e) { toast(e.message, { error: true }); } }
    else if (b.dataset.setup === 'replay-scene') { try { await installReplayScene(); renderSetup(); } catch (e) { toast(e.message, { error: true }); } }
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
  // Scene pickers for auto-switch: OBS scenes, or vMix inputs.
  async function loadSceneChoices(sc) {
    const f = $('#settings-form');
    let data = { inputs: [], scenes: [] };
    try { data = await api('GET', '/api/detect/sources'); } catch { /* app offline */ }
    const names = isVmix() ? data.inputs.map((i) => i.name) : data.scenes;
    for (const [field, blank] of [['gameplay', '(the overlay\'s scene)'], ['after', 'MM BRB']]) {
      const sel = f.elements[`scenes.${field}`];
      const cur = sc[field] || '';
      const opts = [['', blank], ...names.map((n) => [n, n])];
      if (cur && !names.includes(cur)) opts.push([cur, `${cur} (not found)`]);
      sel.innerHTML = opts.map(([v, label]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(label)}</option>`).join('');
    }
  }
  function renderReplaySceneStatus() {
    const r = S && S.replay;
    if (!r) return;
    $('#replay-scene-status').textContent = !S.sw.connected ? 'Connect OBS first.' : r.scene.installed ? `"${r.scene.name}" is in OBS.` : `Not in OBS yet.`;
  }
  async function installReplayScene() {
    const r = await api('POST', '/api/replay/scene');
    toast(`Scene "${r.scene}" ready in OBS. Play a replay to fill it.`);
    renderReplaySceneStatus();
  }
  $('#btn-replay-scene').addEventListener('click', async () => {
    $('#replay-scene-status').textContent = 'Adding…';
    try { await installReplayScene(); } catch (e) { $('#replay-scene-status').textContent = e.message; }
  });
  $('#btn-scenes-add').addEventListener('click', async () => {
    const out = $('#scenes-status');
    out.textContent = 'Adding…';
    try {
      const r = await api('POST', '/api/scenes/install');
      out.textContent = r.vmix
        ? `Added to vMix: ${r.scenes.join(', ')}. Put your gameplay and camera into MM Casters as layers.`
        : `Ready in OBS: ${r.scenes.join(', ')}. ${r.game ? `Casters shows "${r.game}"` : 'No gameplay capture found for Casters: drag it into the big window'}${r.cam ? ` and the camera "${r.cam}".` : '; drag your camera into the small window.'}`;
      loadSceneChoices(S.config.scenes || {});
    } catch (e) { out.textContent = e.message; }
  });
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
