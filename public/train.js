/* TEC Match Recorder: detector training page */
(() => {
  'use strict';
  const $ = (sel) => document.querySelector(sel);
  let S = null;
  let queue = [];
  let templates = {};
  let fighters = [];
  let toastTimer = null;
  let refreshTimer = null;

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  async function api(method, path, body) {
    const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let data = {};
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) throw new Error(data.error || `${method} ${path} failed (${res.status})`);
    return data;
  }
  function toast(message, { error = false } = {}) {
    const el = $('#toast');
    el.className = `toast${error ? ' error' : ''}`;
    el.innerHTML = `<span>${esc(message)}</span>`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, error ? 8000 : 4000);
  }
  const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  const mmss = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const img = (file) => `/api/train/image?dir=samples&file=${encodeURIComponent(file)}`;

  // ---------- rendering ----------
  // Themed stations show their own logo and name here too (colours come from /theme.js and style.css).
  const TEC_MARK = $('#brand-mark').innerHTML;
  function renderBrand() {
    const b = S.branding || { theme: 'tec' };
    const tec = b.theme === 'tec';
    document.documentElement.dataset.theme = b.theme;
    const want = tec ? TEC_MARK : b.logo ? `<img src="${b.logo}" alt="">` : '';
    if ($('#brand-mark').dataset.key !== want) { $('#brand-mark').dataset.key = want; $('#brand-mark').innerHTML = want; }
    $('#brand-org').textContent = b.org || 'Texas Esports Collective';
  }
  function renderHeader() {
    if (!S) return;
    renderBrand();
    const o = $('#chip-obs');
    o.textContent = S.obs.connected ? `OBS ${S.obs.version} connected` : 'OBS not connected';
    o.className = `chip ${S.obs.connected ? 'ok' : 'bad'}`;
    const d = $('#chip-detect');
    const det = S.detect || {};
    d.textContent = det.hasAnchor ? `Detector: ${det.characters} characters learned` : 'Detector: no VS anchor yet (confirm one screen)';
    d.className = `chip ${det.hasAnchor ? 'ok' : 'warn'}`;
    const banner = $('#banner');
    if (!S.obs.connected) { banner.textContent = 'OBS must be running and connected to scan recordings.'; banner.hidden = false; } else banner.hidden = true;
  }
  function renderScan() {
    if (!S) return;
    const t = S.train || {};
    const bar = $('#progress-bar');
    const pct = t.durationMs ? Math.min(100, (t.tMs / t.durationMs) * 100) : 0;
    bar.style.width = `${t.running ? pct : (t.finishedAt ? 100 : 0)}%`;
    const status = $('#scan-status');
    if (t.running) status.textContent = `Scanning ${t.video}: ${mmss(t.tMs)} / ${mmss(t.durationMs)}, ${t.frames} frames looked at, ${t.found} VS screens found.`;
    else if (t.error) status.textContent = `Last scan failed: ${t.error}`;
    else if (t.finishedAt) status.textContent = `Last scan (${t.video}): ${t.frames} frames, ${t.found} VS screens found.`;
    else status.textContent = 'Idle.';
    $('#btn-cancel').hidden = !t.running;
    for (const b of document.querySelectorAll('[data-scan]')) b.disabled = !!t.running || !S.obs.connected;
  }
  function renderVideos(list) {
    $('#video-folder').textContent = list.folder ? `Folder: ${list.folder} (change it in the dashboard Settings)` : 'No videos folder configured.';
    $('#videos').innerHTML = list.videos.length
      ? list.videos.map((v) => `<div class="video-row"><span class="name">${esc(v.name)} <span class="muted">${gb(v.bytes)}</span></span><button class="small" data-scan="${esc(v.path)}">Scan</button></div>`).join('')
      : '<div class="muted">No video files found in that folder.</div>';
    renderScan();
  }
  function renderStats() {
    const chars = Object.keys(templates).sort();
    $('#stat-chars').textContent = chars.length;
    $('#stat-templates').textContent = Object.values(templates).reduce((a, b) => a + b, 0);
    $('#stat-pending').textContent = (S && S.train && S.train.pending) || queue.length;
    $('#learned').innerHTML = chars.length ? chars.map((c) => `<span class="tag">${esc(c)} <span class="muted">×${templates[c]}</span></span>`).join('') : '<span class="muted">Nothing yet. Confirm a few VS screens below.</span>';
  }
  function sideHtml(item, side) {
    const info = item[`p${side}`] || {};
    const alts = (info.alternatives || []).map((a) => `${esc(a.name)} ${(a.score * 100).toFixed(0)}%`).join(' · ');
    const hudAlts = (info.hudAlternatives || []).map((a) => `${esc(a.name)}${a.costume >= 0 ? ` #${a.costume + 1}` : ''} ${(a.score * 100).toFixed(0)}%`).join(' · ');
    const usable = !!(info.maskFile || info.hudCropFile);
    const guess = info.confident || !info.hudGuess ? (info.guess || info.hudGuess || '') : info.hudGuess;
    return `<div class="side">
      <div class="who ${side === 2 ? 'p2' : ''}">P${side}</div>
      <div>
        <div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap">
          ${info.hudCropFile ? `<img class="crop" src="${img(info.hudCropFile)}" alt="P${side} HUD portrait" title="HUD portrait">` : ''}
          ${info.cropFile ? `<img class="crop" src="${img(info.cropFile)}" alt="P${side} name crop" title="VS screen name">` : ''}
          ${usable ? '' : '<div class="muted">Nothing readable on this side.</div>'}
        </div>
        <input list="fighter-list" data-side="${side}" value="${esc(guess)}" placeholder="${usable ? 'Fighter name' : 'leave blank'}" autocomplete="off" ${usable ? '' : 'disabled'}>
        <div class="guess">
          ${info.hudGuess ? `HUD: ${esc(info.hudGuess)}${info.hudCostume >= 0 ? ` #${info.hudCostume + 1}` : ''} (${(info.hudScore * 100).toFixed(0)}%${info.hudConfident ? ', confident' : ''})${hudAlts ? ` · ${hudAlts}` : ''}<br>` : ''}
          ${info.maskFile ? (info.guess ? `VS text: ${esc(info.guess)} (${(info.score * 100).toFixed(0)}%${info.confident ? ', confident' : ''})` : 'VS text: no match yet') + (alts ? ` · ${alts}` : '') : ''}
        </div>
      </div>
    </div>`;
  }
  function renderQueue() {
    const el = $('#queue');
    if (!queue.length) { el.innerHTML = '<div class="muted">Queue is empty. Scan a recording, or wait for live detections that need a second look.</div>'; return; }
    el.innerHTML = queue.map((item, i) => `<div class="review-card${i === 0 ? ' current' : ''}" data-id="${esc(item.id)}">
      <div class="review-top">
        <img class="frame" src="${img(item.frameFile)}" alt="frame">
        <div class="sides">${sideHtml(item, 1)}${sideHtml(item, 2)}</div>
      </div>
      <div class="review-actions">
        <button class="primary" data-confirm="${esc(item.id)}">Confirm</button>
        <button class="small" data-notvs="${esc(item.id)}">Not a VS screen</button>
        <button class="small" data-skip="${esc(item.id)}">Skip</button>
        <span class="meta">${item.source === 'scan' ? `${esc(item.video)} @ ${mmss(item.tMs || 0)}` : 'live detection'} · anchor ${(item.anchorScore * 100).toFixed(0)}%</span>
      </div>
    </div>`).join('');
  }

  // ---------- data ----------
  async function refreshQueue() {
    try {
      const data = await api('GET', '/api/train/queue');
      queue = data.pending || [];
      templates = data.templates || {};
      renderQueue();
      renderStats();
    } catch (e) { toast(e.message, { error: true }); }
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshQueue, 400);
  }
  async function refreshVideos() {
    try { renderVideos(await api('GET', '/api/train/videos')); } catch (e) { toast(e.message, { error: true }); }
  }
  function connect() {
    const es = new EventSource('/api/events');
    es.addEventListener('state', (ev) => { S = JSON.parse(ev.data); renderHeader(); renderScan(); renderStats(); });
    es.addEventListener('train', () => scheduleRefresh());
  }

  // ---------- actions ----------
  async function confirmCard(id) {
    const card = document.querySelector(`.review-card[data-id="${CSS.escape(id)}"]`);
    if (!card) return;
    const p1 = card.querySelector('input[data-side="1"]');
    const p2 = card.querySelector('input[data-side="2"]');
    const body = { id, isVs: true, p1: p1 && !p1.disabled ? p1.value.trim() : '', p2: p2 && !p2.disabled ? p2.value.trim() : '' };
    if (!body.p1 && !body.p2) return toast('Type at least one fighter name, or mark it "Not a VS screen".', { error: true });
    for (const name of [body.p1, body.p2]) {
      if (name && !fighters.some((f) => f.name.toLowerCase() === name.toLowerCase())) return toast(`"${name}" is not a fighter in the roster list. Pick one from the suggestions.`, { error: true });
    }
    body.p1 = canonical(body.p1);
    body.p2 = canonical(body.p2);
    try {
      const r = await api('POST', '/api/train/confirm', body);
      toast(`Learned: ${(r.item.learned || []).join(', ') || 'nothing new'}`);
      await refreshQueue();
      focusFirst();
    } catch (e) { toast(e.message, { error: true }); }
  }
  function canonical(name) {
    if (!name) return '';
    const f = fighters.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return f ? f.name : name;
  }
  function focusFirst() {
    const first = document.querySelector('.review-card.current input:not([disabled])');
    if (first) { first.focus(); first.select(); }
  }
  document.addEventListener('click', async (ev) => {
    const scan = ev.target.closest('[data-scan]');
    if (scan) {
      try {
        await api('POST', '/api/train/scan', { path: scan.dataset.scan, strideMs: Math.round(Number($('#stride').value || 2.5) * 1000), startSec: Number($('#start-min').value || 0) * 60, lanes: Number($('#lanes').value || 4) });
        toast('Scan started. OBS is playing the file in a temporary scene.');
      } catch (e) { toast(e.message, { error: true }); }
      return;
    }
    const c = ev.target.closest('[data-confirm]');
    if (c) { confirmCard(c.dataset.confirm); return; }
    const n = ev.target.closest('[data-notvs]');
    if (n) { try { await api('POST', '/api/train/confirm', { id: n.dataset.notvs, isVs: false }); await refreshQueue(); focusFirst(); } catch (e) { toast(e.message, { error: true }); } return; }
    const s = ev.target.closest('[data-skip]');
    if (s) { try { await api('POST', '/api/train/skip', { id: s.dataset.skip }); await refreshQueue(); focusFirst(); } catch (e) { toast(e.message, { error: true }); } }
  });
  $('#btn-cancel').addEventListener('click', async () => { try { await api('POST', '/api/train/cancel'); } catch (e) { toast(e.message, { error: true }); } });
  $('#btn-clear-reviewed').addEventListener('click', async () => { try { await api('POST', '/api/train/clear-reviewed'); toast('Cleared'); } catch (e) { toast(e.message, { error: true }); } });
  document.addEventListener('keydown', (ev) => {
    const inInput = ev.target && ev.target.tagName === 'INPUT';
    const current = document.querySelector('.review-card.current');
    if (!current) return;
    if (ev.key === 'Enter' && inInput) { ev.preventDefault(); confirmCard(current.dataset.id); }
    else if (!inInput && (ev.key === 'n' || ev.key === 'N')) current.querySelector('[data-notvs]').click();
    else if (!inInput && (ev.key === 's' || ev.key === 'S')) current.querySelector('[data-skip]').click();
  });

  // ---------- boot ----------
  fetch('/api/fighters').then((r) => r.json()).then((list) => {
    fighters = list;
    $('#fighter-list').innerHTML = list.map((f) => `<option value="${esc(f.name)}">`).join('');
  }).catch(() => {});
  connect();
  refreshVideos();
  refreshQueue().then(focusFirst);
})();
