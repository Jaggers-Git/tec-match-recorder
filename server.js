'use strict';
/*
 * TEC Match Recorder: local companion app for OBS Studio.
 *
 * Node.js 22+ only, no npm packages: the built-in WebSocket client talks
 * obs-websocket v5, fetch talks to start.gg, node:http serves the dashboard.
 *
 *   node server.js               start and open the dashboard in a browser
 *   node server.js --no-browser  start without opening a browser
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { Detector } = require('./lib/detector');
const { Trainer } = require('./lib/trainer');
const art = require('./lib/art');

if (typeof WebSocket === 'undefined' || typeof fetch === 'undefined') {
  console.error(`Node.js 22 or newer is required (this is ${process.version}). Download it from https://nodejs.org`);
  process.exit(1);
}

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const BRACKET_PATH = path.join(DATA_DIR, 'bracket.json');
const FIGHTERS_PATH = path.join(ROOT, 'fighters.json');
const STARTGG_API = 'https://api.start.gg/gql/alpha';
const LOW_DISK_BYTES = 25 * 1024 ** 3;
const OPEN_BROWSER = !process.argv.includes('--no-browser');

const DEFAULT_CONFIG = {
  port: 8420,
  obs: { host: '127.0.0.1', port: 4455, password: '' },
  startgg: { token: '', eventUrl: '', eventUrls: [], pollSeconds: 45 },
  event: { name: '', suffix: '' },
  game: 'ssbu',
  games: {},
  naming: {
    titleTemplate: '{event} {round} - {p1} ({chars1}) Vs. {p2} ({chars2}) {suffix}',
    filenamePrefix: true,
    filenamePrefixTemplate: '{date} {set}',
    stripPrefixes: true,
    eventSubfolder: true,
  },
  detect: { enabled: true, source: '', intervalMs: 1000, minScore: 0.6, videosFolder: path.join(os.homedir(), 'Videos') },
  // Stream overlay (Browser Source layer): what the small centre plate shows and where the text boxes sit.
  overlay: { center: 'round', scene: '', boxes: {} },
  // Who may open the dashboard: this PC only (localhost) unless lan is on, in which case a PIN is required.
  network: { lan: false, pin: '' },
};

// ---------- utilities ----------
const log = (...args) => console.log(new Date().toLocaleTimeString(), ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nowIso = () => new Date().toISOString();
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d = new Date()) => `${pad(d.getHours())}${pad(d.getMinutes())}`;

function readJson(file, fallback) {
  // Strip a UTF-8 BOM: Notepad and PowerShell add one, and JSON.parse rejects it.
  try {
    const text = fs.readFileSync(file, 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
function mergeConfig(base, extra) {
  const out = JSON.parse(JSON.stringify(base));
  for (const [key, value] of Object.entries(extra || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object') {
      out[key] = { ...out[key], ...value };
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}
async function waitUntil(test, maxMs, stepMs = 200) {
  const end = Date.now() + maxMs;
  while (!test() && Date.now() < end) await sleep(stepMs);
  return test();
}

// ---------- persistent state ----------
let cfg = mergeConfig(DEFAULT_CONFIG, readJson(CONFIG_PATH, {}));

// ---------- games ----------
// One profile per game the station records. `videogameIds` are start.gg's ids, used to work out which
// game a bracket is for. `characters` switches the character chips and the detector on or off.
// `suffix` ends every title, e.g. "Winners Finals - A Vs. B Smash Ultimate - SSBU".
const GAMES = {
  ssbu: { name: 'Super Smash Bros. Ultimate', short: 'SSBU', suffix: 'Smash Ultimate - SSBU', characters: true, videogameIds: [1386] },
  sf6: { name: 'Street Fighter 6', short: 'SF6', suffix: 'Street Fighter 6 - SF6', characters: false, videogameIds: [43868] },
  tekken8: { name: 'Tekken 8', short: 'T8', suffix: 'Tekken 8 - T8', characters: false, videogameIds: [49783] },
  other: { name: 'Other game', short: '', suffix: '', characters: false, videogameIds: [] },
};
function gameProfile(id) {
  const key = GAMES[id] ? id : 'other';
  const over = (cfg.games && cfg.games[key]) || {};
  return { id: key, ...GAMES[key], ...Object.fromEntries(Object.entries(over).filter(([, v]) => v !== '' && v != null)) };
}
function gameForVideogame(videogameId) {
  const vid = Number(videogameId);
  return Object.keys(GAMES).find((id) => GAMES[id].videogameIds.includes(vid)) || 'other';
}
// Older configs had a single event URL and one global title suffix; fold them into the new shape.
if (cfg.startgg.eventUrl && !(cfg.startgg.eventUrls || []).includes(cfg.startgg.eventUrl)) {
  cfg.startgg.eventUrls = [cfg.startgg.eventUrl, ...(cfg.startgg.eventUrls || [])];
}
if (cfg.event.suffix) {
  if (!(cfg.games.ssbu && cfg.games.ssbu.suffix)) cfg.games.ssbu = { ...(cfg.games.ssbu || {}), suffix: cfg.event.suffix };
  cfg.event.suffix = '';
}
const emptyCurrent = () => ({ setId: '', setLetter: '', round: '', p1: '', p2: '', chars1: [], chars2: [], auto1: [], auto2: [], costume1: -1, costume2: -1, score1: 0, score2: 0, wins1: 0, wins2: 0, bestOf: 1, source: 'manual', game: cfg.game || 'ssbu', eventName: '' });
const clampScore = (n) => Math.max(0, Math.min(99, Math.round(Number(n) || 0)));
// Game wins inside a set (the Bo3/Bo5 pips), separate from the score badge which crews use for stocks.
const clampWins = (n) => Math.max(0, Math.min(3, Math.round(Number(n) || 0)));
const BEST_OF = [1, 3, 5];
const savedState = readJson(STATE_PATH, {});
const state = {
  current: { ...emptyCurrent(), ...(savedState.current || {}) },
  rec: savedState.rec || { active: false, startedAt: null, startedByApp: false },
  log: Array.isArray(savedState.log) ? savedState.log : [],
  recentPlayers: Array.isArray(savedState.recentPlayers) ? savedState.recentPlayers : [],
  recordedSetIds: Array.isArray(savedState.recordedSetIds) ? savedState.recordedSetIds : [],
};
let bracket = readJson(BRACKET_PATH, { slug: '', eventName: '', tournamentName: '', events: [], sets: [], updatedAt: null });
if (!Array.isArray(bracket.events)) bracket.events = [];
if (!Array.isArray(bracket.sets)) bracket.sets = [];
const currentGame = () => gameProfile(state.current.game || cfg.game || 'ssbu');
const sg = { status: 'off', lastSync: null, lastError: '', syncing: false };
const disk = { freeBytes: null, path: '', low: false, checkedAt: null };

let persistTimer = null;
function persistState() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      writeJson(STATE_PATH, {
        current: state.current, rec: state.rec, log: state.log,
        recentPlayers: state.recentPlayers, recordedSetIds: state.recordedSetIds,
      });
    } catch (e) { log('Could not save state:', e.message); }
  }, 150);
}
function addRecentPlayer(name) {
  const n = String(name || '').trim();
  if (!n) return;
  state.recentPlayers = [n, ...state.recentPlayers.filter((x) => x.toLowerCase() !== n.toLowerCase())].slice(0, 40);
}

// ---------- naming ----------
function fillTemplate(template, fields) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => (fields[key] ?? ''));
}
function tidyText(s) {
  return String(s)
    .replace(/\s*\(\s*\)/g, '')            // "Name ()" -> "Name" when no characters were entered
    .replace(/\s+/g, ' ')
    .replace(/(?:\s*-\s*){2,}/g, ' - ')   // " -  - " left by an empty field
    .replace(/^(?:\s*-\s*)+/, '')
    .replace(/(?:\s*-\s*)+$/, '')
    .trim();
}
function sanitizeFilename(s) {
  return String(s)
    .replace(/[/\\]/g, '-')
    .replace(/[<>:"|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 180);
}
function eventDisplayName() {
  return String(cfg.event.name || bracket.tournamentName || '').trim();
}
function buildLabel(current) {
  const game = gameProfile(current.game || cfg.game || 'ssbu');
  const fields = {
    game: game.short || '',
    event: eventDisplayName(),
    round: current.round || '',
    set: current.setLetter || '',
    p1: current.p1 || 'Player 1',
    p2: current.p2 || 'Player 2',
    chars1: (current.chars1 || []).join(', '),
    chars2: (current.chars2 || []).join(', '),
    score: `${current.score1 || 0}-${current.score2 || 0}`,
    suffix: game.suffix || '',
    date: localDate(),
    time: localTime(),
  };
  const title = tidyText(fillTemplate(cfg.naming.titleTemplate, fields));
  const prefix = cfg.naming.filenamePrefix ? tidyText(fillTemplate(cfg.naming.filenamePrefixTemplate, fields)) : '';
  const filenameBase = sanitizeFilename(prefix ? `${prefix} - ${title}` : title) || `Recording ${localDate()} ${localTime()}`;
  return { title, filenameBase };
}

// ---------- OBS WebSocket (protocol v5) ----------
const EVENT_SUB_GENERAL = 1;
const EVENT_SUB_OUTPUTS = 64;

class ObsClient {
  constructor() {
    this.ws = null;
    this.gen = 0;
    this.status = 'disconnected';
    this.lastError = '';
    this.version = '';
    this.recording = false;
    this.recordDirectory = '';
    this.pending = new Map();
    this.reconnectTimer = null;
    this.handlers = { event: [], status: [] };
  }
  on(kind, fn) { this.handlers[kind].push(fn); }
  emit(kind, payload) {
    for (const fn of this.handlers[kind]) {
      try { fn(payload); } catch (e) { log('handler error:', e); }
    }
  }
  setStatus(status, error = '') {
    this.status = status;
    this.lastError = error;
    this.emit('status', status);
  }
  connect() {
    clearTimeout(this.reconnectTimer);
    this.gen += 1;
    const gen = this.gen;
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } this.ws = null; }
    this.failPending(new Error('Reconnecting to OBS'));
    const url = `ws://${cfg.obs.host || '127.0.0.1'}:${cfg.obs.port || 4455}`;
    this.setStatus('connecting');
    let ws;
    try { ws = new WebSocket(url); } catch (e) { this.onClose(gen, 1006, String(e.message || e)); return; }
    this.ws = ws;
    ws.addEventListener('message', (m) => {
      if (gen !== this.gen) return;
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      this.handleMessage(msg);
    });
    ws.addEventListener('error', () => {
      // A close event normally follows; if it doesn't, don't get stuck in "connecting".
      setTimeout(() => { if (gen === this.gen && this.status === 'connecting') this.onClose(gen, 1006, ''); }, 1500);
    });
    ws.addEventListener('close', (e) => { if (gen === this.gen) this.onClose(gen, e.code, e.reason); });
  }
  onClose(gen, code, reason) {
    if (gen !== this.gen || this.closedGen === gen) return;
    this.closedGen = gen;
    this.ws = null;
    this.recording = false;
    this.failPending(new Error('OBS connection closed'));
    let message;
    if (code === 4009) message = 'Authentication failed: check the OBS WebSocket password in Settings.';
    else if (code === 4008) message = 'OBS rejected our protocol version.';
    else if (code === 1006 && !reason) message = 'OBS is not running, or its WebSocket server is off (OBS → Tools → WebSocket Server Settings).';
    else message = reason || `Connection closed (${code}).`;
    this.setStatus(code === 4009 ? 'auth-failed' : 'disconnected', message);
    this.reconnectTimer = setTimeout(() => this.connect(), code === 4009 ? 15000 : 3000);
  }
  failPending(err) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }
  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }
  handleMessage(msg) {
    const { op, d } = msg;
    if (op === 0) { // Hello
      let authentication;
      if (d.authentication) {
        const { challenge, salt } = d.authentication;
        const secret = crypto.createHash('sha256').update(cfg.obs.password + salt).digest('base64');
        authentication = crypto.createHash('sha256').update(secret + challenge).digest('base64');
      }
      this.send({ op: 1, d: { rpcVersion: 1, authentication, eventSubscriptions: EVENT_SUB_GENERAL | EVENT_SUB_OUTPUTS } });
    } else if (op === 2) { // Identified
      this.setStatus('connected');
      this.afterConnect().catch((e) => log('OBS post-connect error:', e.message));
    } else if (op === 5) { // Event
      if (d.eventType === 'RecordStateChanged') {
        const data = d.eventData || {};
        this.recording = !!data.outputActive;
        this.emit('event', { type: 'record', state: data.outputState, active: !!data.outputActive, path: data.outputPath || null });
      }
    } else if (op === 7) { // RequestResponse
      const p = this.pending.get(d.requestId);
      if (!p) return;
      this.pending.delete(d.requestId);
      clearTimeout(p.timer);
      const st = d.requestStatus || {};
      if (st.result) p.resolve(d.responseData || {});
      else p.reject(new Error(st.comment || `OBS refused ${d.requestType} (code ${st.code})`));
    }
  }
  request(requestType, requestData = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (this.status !== 'connected' || !this.ws) return reject(new Error('OBS is not connected'));
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`OBS did not answer ${requestType}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send({ op: 6, d: { requestType, requestId, requestData } });
    });
  }
  async afterConnect() {
    // OBS accepts WebSocket clients before it has finished loading, so the first
    // requests can time out right after OBS starts. Keep trying while connected.
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        const v = await this.request('GetVersion');
        this.version = v.obsVersion || '';
        const d = await this.request('GetRecordDirectory');
        this.recordDirectory = d.recordDirectory || '';
        const s = await this.request('GetRecordStatus');
        this.recording = !!s.outputActive;
        log(`Connected to OBS ${this.version}, recordings go to ${this.recordDirectory}`);
        this.emit('event', { type: 'ready', recording: this.recording, durationMs: s.outputDuration || 0 });
        return;
      } catch (e) {
        if (this.status !== 'connected') return;
        log(`OBS is not answering yet (attempt ${attempt}): ${e.message}`);
        await sleep(3000);
      }
    }
  }
}

const obs = new ObsClient();
obs.on('status', () => broadcast());
obs.on('event', (ev) => {
  if (ev.type === 'ready') {
    if (ev.recording && !state.rec.active) adoptRecording(Date.now() - (ev.durationMs || 0));
    if (!ev.recording && state.rec.active) {
      state.rec = { active: false, startedAt: null, startedByApp: false };
      persistState();
    }
    checkDisk();
    trainer.cleanupLeftovers();
    if (obs.recordDirectory && cfg.lastRecordDirectory !== obs.recordDirectory) { cfg.lastRecordDirectory = obs.recordDirectory; writeJson(CONFIG_PATH, cfg); }
  } else if (ev.type === 'record') {
    if (ev.state === 'OBS_WEBSOCKET_OUTPUT_STARTED') {
      lastStopped = null;
      if (!state.rec.active) adoptRecording(Date.now());
    }
    if (ev.state === 'OBS_WEBSOCKET_OUTPUT_STOPPED') {
      resolveStopped(ev.path);
      if (state.rec.active && !stopInProgress) {
        log('Recording was stopped from inside OBS, labeling it anyway');
        stopRecording({ externalPath: ev.path }).catch((e) => log('external stop failed:', e.message));
      }
    }
  }
  broadcast();
});
function adoptRecording(startedAt) {
  state.rec = { active: true, startedAt, startedByApp: false };
  persistState();
}

let lastStopped = null;
let stoppedWaiters = [];
function resolveStopped(p) {
  lastStopped = { path: p, at: Date.now() };
  const waiters = stoppedWaiters;
  stoppedWaiters = [];
  for (const w of waiters) w(p);
}
function waitForStoppedPath(ms) {
  if (lastStopped && Date.now() - lastStopped.at < 15000) return Promise.resolve(lastStopped.path);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    stoppedWaiters.push((p) => { clearTimeout(t); resolve(p); });
  });
}

// ---------- recording lifecycle ----------
let stopInProgress = false;

async function startRecording() {
  if (obs.status !== 'connected') throw new Error('OBS is not connected');
  if (state.rec.active) throw new Error('Already recording');
  const status = await obs.request('GetRecordStatus');
  lastStopped = null;
  if (status.outputActive) {
    adoptRecording(Date.now() - (status.outputDuration || 0));
    broadcast();
    return;
  }
  await obs.request('StartRecord');
  state.rec = { active: true, startedAt: Date.now(), startedByApp: true };
  persistState();
  broadcast();
  log('Recording started');
}

async function stopRecording({ externalPath = null } = {}) {
  if (!state.rec.active) throw new Error('Not recording');
  if (stopInProgress) throw new Error('Already stopping');
  stopInProgress = true;
  try {
    const label = buildLabel(state.current);
    const entry = {
      id: crypto.randomUUID(), ts: nowIso(), date: localDate(), time: localTime(),
      game: currentGame().short || '', gameId: currentGame().id,
      event: eventDisplayName(), round: state.current.round || '', set: state.current.setLetter || '', setId: state.current.setId || '',
      p1: state.current.p1 || '', p2: state.current.p2 || '',
      chars1: [...(state.current.chars1 || [])], chars2: [...(state.current.chars2 || [])],
      costume1: state.current.costume1 ?? -1, costume2: state.current.costume2 ?? -1,
      score1: state.current.score1 || 0, score2: state.current.score2 || 0,
      wins1: state.current.wins1 || 0, wins2: state.current.wins2 || 0, bestOf: state.current.bestOf || 1,
      title: label.title, filenameBase: label.filenameBase,
      sourcePath: externalPath || '', path: '', filename: '',
      durationSec: Math.max(0, Math.round((Date.now() - (state.rec.startedAt || Date.now())) / 1000)),
      status: 'saving', error: '',
    };
    if (!externalPath) {
      let res;
      try {
        res = await obs.request('StopRecord', {}, 30000);
      } catch (e) {
        if (/not active|not recording/i.test(e.message)) {
          state.rec = { active: false, startedAt: null, startedByApp: false };
          persistState();
          broadcast();
          throw new Error('OBS says it was not recording, nothing to save');
        }
        throw e;
      }
      entry.sourcePath = res.outputPath || '';
    }
    state.rec = { active: false, startedAt: null, startedByApp: false };
    state.log.unshift(entry);
    if (state.log.length > 1000) state.log.length = 1000;
    addRecentPlayer(entry.p1);
    addRecentPlayer(entry.p2);
    if (entry.setId && !state.recordedSetIds.includes(entry.setId)) state.recordedSetIds.push(entry.setId);
    state.current = emptyCurrent();
    detector.resetLocks();
    persistState();
    broadcast();
    log(`Recording stopped → "${entry.title}"`);
    finalizeEntry(entry);
    return entry;
  } finally {
    stopInProgress = false;
  }
}

async function finalizeEntry(entry) {
  entry.status = 'saving';
  entry.error = '';
  broadcast();
  try {
    if (!entry.sourcePath) entry.sourcePath = (await waitForStoppedPath(10000)) || '';
    if (!entry.sourcePath) throw new Error('OBS did not report where it saved the recording');
    await waitUntil(() => !obs.recording, 8000);
    const finalPath = await moveRecording(entry.sourcePath, entry);
    entry.path = finalPath;
    entry.filename = path.basename(finalPath);
    entry.status = 'saved';
    await appendCsv(path.dirname(finalPath), entry);
    log(`Saved ${entry.filename}`);
  } catch (e) {
    entry.status = 'error';
    entry.error = String(e.message || e);
    log(`Could not finalize "${entry.title}": ${entry.error}`);
  }
  persistState();
  broadcast();
}

function targetDirFor(sourcePath) {
  const base = path.dirname(sourcePath);
  if (!cfg.naming.eventSubfolder) return base;
  return path.join(base, sanitizeFilename(eventDisplayName()) || 'Recordings');
}
function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, base + ext);
  let n = 2;
  while (fs.existsSync(candidate)) candidate = path.join(dir, `${base} -${n++}${ext}`);
  return candidate;
}
function remuxedSibling(src) {
  const base = path.basename(src, path.extname(src));
  const dir = path.dirname(src);
  for (const ext of ['.mp4', '.mov', '.mkv']) {
    const candidate = path.join(dir, base + ext);
    if (candidate.toLowerCase() !== src.toLowerCase() && fs.existsSync(candidate)) return candidate;
  }
  return null;
}
async function waitForStableFile(file, maxMs) {
  const end = Date.now() + maxMs;
  let last = -1;
  let stable = 0;
  while (Date.now() < end) {
    let size = -1;
    try { size = fs.statSync(file).size; } catch { /* not there yet */ }
    if (size >= 0 && size === last) { stable += 1; if (stable >= 3) return true; } else stable = 0;
    last = size;
    await sleep(1000);
  }
  return false;
}
async function moveRecording(sourcePath, entry) {
  const dir = targetDirFor(sourcePath);
  await fsp.mkdir(dir, { recursive: true });
  let src = sourcePath;
  // With "Automatically remux to mp4" on, OBS starts writing an .mp4 next to the .mkv right after stopping.
  await sleep(1500);
  const sibling = remuxedSibling(sourcePath);
  if (sibling) {
    log(`OBS is remuxing to ${path.basename(sibling)}, waiting for it to finish`);
    await waitForStableFile(sibling, 10 * 60 * 1000);
    src = sibling;
  }
  const deadline = Date.now() + 120000;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (!fs.existsSync(src)) {
      const alt = remuxedSibling(src);
      if (alt) { src = alt; continue; }
      lastErr = new Error(`file not found: ${src}`);
      await sleep(1000);
      continue;
    }
    const target = uniquePath(dir, entry.filenameBase, path.extname(src));
    try {
      await fsp.rename(src, target);
      return target;
    } catch (e) {
      lastErr = e;
      if (e.code === 'EXDEV') {
        await fsp.copyFile(src, target);
        await fsp.unlink(src);
        return target;
      }
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOENT'].includes(e.code)) throw e;
    }
    await sleep(1000);
  }
  const why = (lastErr && (lastErr.code || lastErr.message)) || 'unknown';
  throw new Error(`Gave up renaming ${path.basename(src)} (${why}). The file is still in ${path.dirname(src)}.`);
}

const CSV_HEADER = ['Player 1', 'Character(s)', 'Player 2', 'Character(s)', 'Round', 'Set', 'Date', 'Time', 'Duration', 'Title', 'Filename', 'Event', 'P1 Costume', 'P2 Costume', 'Game', 'Score', 'Games'];
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function fmtDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
async function appendCsv(dir, entry) {
  const file = path.join(dir, 'recordings.csv');
  const row = [
    entry.p1, entry.chars1.join(', '), entry.p2, entry.chars2.join(', '), entry.round, entry.set,
    entry.date, entry.time.replace(/^(\d\d)(\d\d)$/, '$1:$2'), fmtDuration(entry.durationSec),
    entry.title, entry.filename, entry.event,
    entry.costume1 >= 0 ? entry.costume1 + 1 : '', entry.costume2 >= 0 ? entry.costume2 + 1 : '',
    entry.game || '',
    `${entry.score1 || 0}-${entry.score2 || 0}`,
    (entry.bestOf || 1) > 1 ? `${entry.wins1 || 0}-${entry.wins2 || 0} (Bo${entry.bestOf})` : '',
  ].map(csvCell).join(',');
  const fresh = !fs.existsSync(file);
  if (!fresh) await upgradeCsvHeader(file);
  // BOM so Excel opens the file as UTF-8 (Pokémon, accented tags).
  const bom = String.fromCharCode(0xfeff);
  await fsp.appendFile(file, `${fresh ? `${bom}${CSV_HEADER.join(',')}\r\n` : ''}${row}\r\n`);
}

// A CSV started before a column was added keeps its old header; bring it up to date so every row lines up.
async function upgradeCsvHeader(file) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    const header = CSV_HEADER.join(',');
    if (lines[0] === header) return;
    const oldCount = lines[0].split(',').length;
    const body = lines.slice(1).filter((l) => l.length).map((l) => {
      const cells = l.split(',').length;
      return cells === oldCount && cells < CSV_HEADER.length ? l + ','.repeat(CSV_HEADER.length - cells) : l;
    });
    await fsp.writeFile(file, `${String.fromCharCode(0xfeff)}${header}\r\n${body.join('\r\n')}\r\n`);
    log(`recordings.csv header updated to ${CSV_HEADER.length} columns`);
  } catch (e) { log('Could not update the CSV header:', e.message); }
}

// ---------- current match ----------
function patchCurrent(body) {
  const b = body || {};
  for (const k of ['setId', 'setLetter', 'round', 'p1', 'p2', 'source']) {
    if (typeof b[k] === 'string') state.current[k] = b[k].slice(0, 120);
  }
  for (const k of ['score1', 'score2']) if (b[k] !== undefined) state.current[k] = clampScore(b[k]);
  for (const k of ['wins1', 'wins2']) if (b[k] !== undefined) state.current[k] = clampWins(b[k]);
  if (b.bestOf !== undefined && BEST_OF.includes(Number(b.bestOf))) state.current.bestOf = Number(b.bestOf);
  if (typeof b.game === 'string' && GAMES[b.game]) {
    state.current.game = b.game;
    if (cfg.game !== b.game) { cfg.game = b.game; writeJson(CONFIG_PATH, cfg); }
    if (!gameProfile(b.game).characters) { state.current.chars1 = []; state.current.chars2 = []; state.current.auto1 = []; state.current.auto2 = []; }
  }
  for (const k of ['chars1', 'chars2']) {
    if (Array.isArray(b[k])) state.current[k] = b[k].filter((x) => typeof x === 'string').map((x) => x.slice(0, 40)).slice(0, 8);
  }
  for (const n of [1, 2]) state.current[`auto${n}`] = (state.current[`auto${n}`] || []).filter((c) => state.current[`chars${n}`].includes(c));
  persistState();
  broadcast();
}
function pickName(set, n) {
  return (cfg.naming.stripPrefixes ? set[`p${n}Tag`] : set[`p${n}Full`]) || '';
}
function selectSet(s) {
  const same = state.current.setId === s.id;
  state.current = {
    setId: s.id,
    setLetter: s.multiPool && s.pool ? `${s.pool}-${s.letter || ''}` : (s.letter || ''),
    round: s.multiPool && s.pool ? `Pool ${s.pool} ${s.roundLabel || s.round || ''}`.trim() : (s.round || ''),
    p1: pickName(s, 1), p2: pickName(s, 2),
    chars1: same ? state.current.chars1 : [], chars2: same ? state.current.chars2 : [],
    auto1: same ? state.current.auto1 || [] : [], auto2: same ? state.current.auto2 || [] : [],
    score1: same ? state.current.score1 || 0 : 0, score2: same ? state.current.score2 || 0 : 0,
    wins1: same ? state.current.wins1 || 0 : 0, wins2: same ? state.current.wins2 || 0 : 0,
    bestOf: state.current.bestOf || 1,
    source: 'startgg', game: s.game || cfg.game || 'ssbu', eventName: s.eventName || '',
  };
  detector.resetLocks();
  persistState();
  broadcast();
}

// ---------- start.gg ----------
function parseEventSlug(input) {
  const m = String(input || '').match(/tournament\/([^/\s?#]+)\/event\/([^/\s?#]+)/i);
  return m ? `tournament/${m[1]}/event/${m[2]}` : '';
}
const SETS_QUERY = `query EventSets($slug: String!, $page: Int!, $perPage: Int!) {
  event(slug: $slug) {
    id
    name
    tournament { name }
    videogame { id name }
    sets(page: $page, perPage: $perPage, sortType: STANDARD) {
      pageInfo { total totalPages }
      nodes {
        id
        identifier
        round
        fullRoundText
        state
        winnerId
        startedAt
        completedAt
        phaseGroup { displayIdentifier phase { id name } }
        slots { entrant { id name participants { gamerTag prefix } } }
      }
    }
  }
}`;

const TOURNAMENT_QUERY = `query TournamentEvents($slug: String!) {
  tournament(slug: $slug) {
    id
    name
    events { id name slug numEntrants videogame { id name } teamRosterSize { minPlayers maxPlayers } }
  }
}`;
function parseTournamentSlug(input) {
  const m = String(input || '').match(/tournament\/([^/\s?#]+)/i);
  return m ? m[1] : '';
}
// Add every event of a tournament the station knows how to record: Ultimate singles (no doubles,
// crews or squad strike), Street Fighter 6 and Tekken 8. Reports what was added and what was skipped.
async function importTournament(url) {
  const slug = parseTournamentSlug(url);
  if (!slug) throw new Error('That is not a start.gg tournament URL');
  if (!cfg.startgg.token) throw new Error('Add the start.gg API token first');
  const data = await gql(TOURNAMENT_QUERY, { slug });
  const t = data && data.tournament;
  if (!t) throw new Error(`Tournament not found: ${slug}`);
  const added = [];
  const skipped = [];
  const urls = [...(cfg.startgg.eventUrls || [])];
  for (const ev of t.events || []) {
    const game = gameForVideogame(ev.videogame && ev.videogame.id);
    const teams = !!(ev.teamRosterSize && (ev.teamRosterSize.maxPlayers || 0) > 1);
    const nonSingles = teams || /doubles|dubs|\b[23]v[23]\b|crew|squad|\bteams?\b/i.test(ev.name || '');
    const label = `${ev.name} (${(ev.videogame && ev.videogame.name) || 'unknown game'}${ev.numEntrants ? `, ${ev.numEntrants} entrants` : ''})`;
    if (game === 'other') { skipped.push(`${label}: game not set up in the recorder`); continue; }
    if (nonSingles) { skipped.push(`${label}: not a singles bracket`); continue; }
    const eventUrl = `https://www.start.gg/${ev.slug}`;
    if (urls.some((u) => parseEventSlug(u) === parseEventSlug(eventUrl))) { skipped.push(`${label}: already added`); continue; }
    urls.push(eventUrl);
    added.push(label);
  }
  if (added.length) updateConfig({ startgg: { eventUrls: urls } });
  return { tournament: t.name, added, skipped, eventUrls: urls };
}

async function gql(query, variables) {
  let res;
  try {
    res = await fetch(cfg.startgg.apiUrl || STARTGG_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.startgg.token}` },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw Object.assign(new Error('No connection to start.gg'), { kind: 'network' });
  }
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error('start.gg rejected the API token'), { kind: 'auth' });
  if (res.status === 429) throw Object.assign(new Error('start.gg rate limit hit, will retry'), { kind: 'network' });
  if (!res.ok) throw Object.assign(new Error(`start.gg answered HTTP ${res.status}`), { kind: 'network' });
  const body = await res.json();
  if (body.errors && body.errors.length) {
    throw Object.assign(new Error(body.errors.map((e) => e.message).join('; ')), { kind: 'gql' });
  }
  return body.data;
}
function normalizeRoundText(text) {
  return String(text || '')
    .replace(/Grand Final Reset/i, 'Grand Finals Reset')
    .replace(/Quarter-?Finals?/i, 'Quarters')
    .replace(/Semi-?Finals?/i, 'Semis')
    .replace(/\bFinal\b/i, 'Finals')
    .trim();
}
function mapState(s) {
  switch (s) {
    case 3: return 'completed';
    case 2: return 'in_progress';
    case 6: return 'called';
    default: return 'pending';
  }
}
function entrantNames(e) {
  if (!e) return { tag: '', full: '' };
  const full = String(e.name || '').replace(/\s*\/\s*/g, ' & ').trim();
  const tags = (e.participants || []).map((p) => String(p.gamerTag || '').trim()).filter(Boolean);
  // Crews (3+ players) are titled by the crew name; singles and doubles keep the player tags.
  if (tags.length >= 3 && full) return { tag: full.replace(/^.*\|\s*/, ''), full };
  return { tag: tags.length ? tags.join(' & ') : full.replace(/^.*\|\s*/, ''), full };
}
function mapSet(n, phaseOrder) {
  const phase = (n.phaseGroup && n.phaseGroup.phase) || {};
  const phaseId = String(phase.id || '');
  if (!phaseOrder.has(phaseId)) phaseOrder.set(phaseId, phaseOrder.size);
  const phaseName = phase.name || '';
  const isPools = /pool/i.test(phaseName);
  const slots = n.slots || [];
  const e1 = entrantNames(slots[0] && slots[0].entrant);
  const e2 = entrantNames(slots[1] && slots[1].entrant);
  const roundLabel = normalizeRoundText(n.fullRoundText);
  return {
    id: String(n.id), letter: n.identifier || '', roundNum: n.round || 0,
    roundLabel, round: isPools ? 'Pools' : roundLabel,
    phase: phaseName, phaseIdx: phaseOrder.get(phaseId), isPools,
    pool: (n.phaseGroup && n.phaseGroup.displayIdentifier) || '',
    state: mapState(n.state),
    p1Tag: e1.tag, p1Full: e1.full, p2Tag: e2.tag, p2Full: e2.full,
    p1Id: slots[0] && slots[0].entrant ? String(slots[0].entrant.id) : '',
    p2Id: slots[1] && slots[1].entrant ? String(slots[1].entrant.id) : '',
    winnerId: n.winnerId ? String(n.winnerId) : '',
    startedAt: n.startedAt || null, completedAt: n.completedAt || null,
  };
}

const eventSlugs = () => [...new Set((cfg.startgg.eventUrls || []).map(parseEventSlug).filter(Boolean))];

async function fetchEvent(slug, phaseOrder) {
  const sets = [];
  let page = 1;
  let totalPages = 1;
  let meta = null;
  do {
    const data = await gql(SETS_QUERY, { slug, page, perPage: 40 });
    const ev = data && data.event;
    if (!ev) throw Object.assign(new Error(`Event not found: ${slug}`), { kind: 'gql' });
    if (!meta) {
      const videogameId = ev.videogame ? Number(ev.videogame.id) : 0;
      meta = {
        slug, eventName: ev.name || '', tournamentName: (ev.tournament && ev.tournament.name) || '',
        videogameId, videogameName: (ev.videogame && ev.videogame.name) || '', game: gameForVideogame(videogameId),
      };
    }
    totalPages = (ev.sets && ev.sets.pageInfo && ev.sets.pageInfo.totalPages) || 1;
    for (const node of (ev.sets && ev.sets.nodes) || []) sets.push({ ...mapSet(node, phaseOrder), eventSlug: slug, eventName: meta.eventName, game: meta.game });
    page += 1;
  } while (page <= totalPages && page <= 40);
  // Phases that run several pools (San Japan: "Bracket" with pools A1, A2, ...) repeat the set letters
  // per pool, so flag them and let the UI and file names carry the pool along.
  const poolsByPhase = new Map();
  for (const s of sets) {
    if (!poolsByPhase.has(s.phaseIdx)) poolsByPhase.set(s.phaseIdx, new Set());
    if (s.pool) poolsByPhase.get(s.phaseIdx).add(s.pool);
  }
  for (const s of sets) s.multiPool = (poolsByPhase.get(s.phaseIdx) || new Set()).size > 1;
  return { ...meta, setCount: sets.length, sets };
}

async function syncStartgg() {
  const slugs = eventSlugs();
  if (!cfg.startgg.token || !slugs.length) {
    if (sg.status !== 'off') { sg.status = 'off'; sg.lastError = ''; broadcast(); }
    return;
  }
  if (sg.syncing) return;
  sg.syncing = true;
  broadcast();
  try {
    // Several brackets can run on one station in a night (Ultimate, SF6, Tekken). Each start.gg
    // event is fetched in turn and its sets are tagged with the event and the game they belong to.
    const phaseOrder = new Map();
    const events = [];
    const sets = [];
    const failures = [];
    for (const slug of slugs) {
      try {
        const ev = await fetchEvent(slug, phaseOrder);
        events.push({ slug: ev.slug, eventName: ev.eventName, tournamentName: ev.tournamentName, videogameId: ev.videogameId, videogameName: ev.videogameName, game: ev.game, setCount: ev.setCount });
        sets.push(...ev.sets);
      } catch (e) {
        if (e.kind === 'gql') failures.push(e.message); else throw e;
      }
    }
    if (!events.length) throw Object.assign(new Error(failures.join('; ') || 'No events could be loaded'), { kind: 'gql' });

    const previous = new Map(bracket.sets.map((s) => [s.id, s]));
    bracket = {
      slug: events[0].slug, eventName: events.map((e) => e.eventName).join(' + '), tournamentName: events[0].tournamentName,
      events, sets, updatedAt: nowIso(),
    };
    writeJson(BRACKET_PATH, bracket);

    // If the selected set was TBD when picked, fill the names in as they appear on start.gg.
    if (state.current.source === 'startgg' && state.current.setId) {
      const fresh = sets.find((s) => s.id === state.current.setId);
      const old = previous.get(state.current.setId);
      if (fresh && old) {
        for (const n of [1, 2]) {
          const key = `p${n}`;
          if (!state.current[key] || state.current[key] === pickName(old, n)) state.current[key] = pickName(fresh, n);
        }
        if (!state.current.round || state.current.round === old.round) state.current.round = fresh.round;
        persistState();
      }
    }
    sg.status = 'live';
    sg.lastSync = nowIso();
    sg.lastError = failures.length ? `Some events failed: ${failures.join('; ')}` : '';
    broadcastBracket();
  } catch (e) {
    sg.lastError = e.message;
    sg.status = e.kind === 'auth' || e.kind === 'gql' ? 'error' : 'offline';
    log(`start.gg sync failed: ${e.message}`);
  } finally {
    sg.syncing = false;
    broadcast();
  }
}
let pollTimer = null;
function schedulePoll() {
  clearInterval(pollTimer);
  const secs = Math.max(15, Number(cfg.startgg.pollSeconds) || 45);
  pollTimer = setInterval(() => syncStartgg(), secs * 1000);
}

// ---------- disk ----------
async function checkDisk() {
  const p = obs.recordDirectory && fs.existsSync(obs.recordDirectory) ? obs.recordDirectory : os.homedir();
  try {
    const s = await fsp.statfs(p);
    disk.freeBytes = Number(s.bavail) * Number(s.bsize);
    disk.path = p;
    disk.low = disk.freeBytes < LOW_DISK_BYTES;
    disk.checkedAt = nowIso();
  } catch {
    disk.freeBytes = null;
  }
  broadcast();
}

// ---------- config ----------
function publicConfig() {
  return {
    ...cfg,
    obs: { ...cfg.obs, password: '', hasPassword: !!cfg.obs.password },
    startgg: { ...cfg.startgg, token: '', hasToken: !!cfg.startgg.token, eventSlug: eventSlugs()[0] || '', eventSlugs: eventSlugs() },
    gameList: Object.keys(GAMES).map((id) => { const g = gameProfile(id); return { id, name: g.name, short: g.short, suffix: g.suffix, characters: !!g.characters }; }),
  };
}
function updateConfig(body) {
  const incoming = body && typeof body === 'object' ? body : {};
  if (incoming.startgg && !incoming.startgg.token) delete incoming.startgg.token;
  if (incoming.obs && !incoming.obs.password) delete incoming.obs.password;
  if (incoming.startgg && typeof incoming.startgg.eventUrls === 'string') {
    incoming.startgg.eventUrls = incoming.startgg.eventUrls.split(/[\r\n,]+/).map((s) => s.trim()).filter(Boolean);
  }
  if (incoming.startgg && Array.isArray(incoming.startgg.eventUrls)) incoming.startgg.eventUrl = incoming.startgg.eventUrls[0] || '';
  const next = mergeConfig(cfg, incoming);
  next.port = Number(next.port) || 8420;
  next.obs.port = Number(next.obs.port) || 4455;
  next.startgg.pollSeconds = Math.max(15, Number(next.startgg.pollSeconds) || 45);
  next.network = { lan: !!(next.network && next.network.lan), pin: String((next.network && next.network.pin) || '').replace(/D/g, '').slice(0, 8) };
  if (next.network.lan && !next.network.pin) next.network.pin = String(crypto.randomInt(100000, 1000000));
  const lanChanged = !!next.network.lan !== !!(cfg.network && cfg.network.lan);
  const obsChanged = JSON.stringify(next.obs) !== JSON.stringify(cfg.obs);
  const sgChanged = JSON.stringify(next.startgg) !== JSON.stringify(cfg.startgg);
  cfg = next;
  if (lanChanged) setTimeout(rebindServer, 200);
  writeJson(CONFIG_PATH, cfg);
  if (obsChanged) obs.connect();
  if (sgChanged) { schedulePoll(); syncStartgg(); } else broadcastBracket();
  broadcast();
}

// ---------- HTTP + SSE ----------
function lanUrls() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${cfg.port}`);
  }
  return out;
}
function snapshot() {
  return {
    obs: {
      status: obs.status, connected: obs.status === 'connected', recording: obs.recording,
      recordDirectory: obs.recordDirectory, version: obs.version, lastError: obs.lastError,
    },
    rec: state.rec,
    startgg: {
      ...sg,
      configured: !!(cfg.startgg.token && eventSlugs().length),
      eventName: bracket.eventName, tournamentName: bracket.tournamentName, events: bracket.events || [],
      updatedAt: bracket.updatedAt, setCount: bracket.sets.length,
    },
    current: state.current,
    preview: buildLabel(state.current),
    log: state.log.slice(0, 200),
    recentPlayers: state.recentPlayers,
    recordedSetIds: state.recordedSetIds,
    disk,
    detect: detector.status(),
    train: trainer.status(),
    config: publicConfig(),
    eventDisplayName: eventDisplayName(),
    lan: cfg.network && cfg.network.lan ? lanUrls() : [],
    network: { lan: !!(cfg.network && cfg.network.lan), pin: (cfg.network && cfg.network.pin) || '' },
    art: artStatus(),
  };
}
function bracketPayload() {
  return {
    slug: bracket.slug, eventName: bracket.eventName, tournamentName: bracket.tournamentName, updatedAt: bracket.updatedAt,
    events: bracket.events || [],
    sets: bracket.sets.map((s) => ({ ...s, p1: pickName(s, 1), p2: pickName(s, 2) })),
  };
}

const sseClients = new Set();
function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
let broadcastTimer = null;
function broadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    const snap = snapshot();
    for (const c of sseClients) sseSend(c, 'state', snap);
  }, 30);
}
function broadcastBracket() {
  const b = bracketPayload();
  for (const c of sseClients) sseSend(c, 'bracket', b);
}
setInterval(() => { for (const c of sseClients) c.write(': ping\n\n'); }, 20000);

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname === '/train' ? 'train.html' : pathname === '/overlay' ? 'overlay.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}
function openFolder() {
  const last = state.log.find((e) => e.status === 'saved' && e.path);
  const dir = last ? path.dirname(last.path) : (obs.recordDirectory || os.homedir());
  if (process.platform === 'win32') spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
  return dir;
}

// ---------- character detection + training ----------
const detector = new Detector({
  dataDir: DATA_DIR,
  obs,
  rosterNames: readJson(FIGHTERS_PATH, []).map((f) => f.name),
  getCfg: () => cfg,
  log,
  shouldRun: () => obs.status === 'connected' && !!cfg.detect.enabled && !trainer.isScanning() && !!currentGame().characters,
  getSource: async () => cfg.detect.source || (await obs.request('GetCurrentProgramScene')).currentProgramSceneName,
  onDetection: ({ side, character, score, costume = -1, kind = 'vs' }) => {
    const chars = state.current[`chars${side}`];
    if (costume >= 0) state.current[`costume${side}`] = costume;
    if (chars.includes(character) || chars.length >= 8) { persistState(); broadcast(); return; }
    chars.push(character);
    state.current[`auto${side}`] = [...(state.current[`auto${side}`] || []), character];
    persistState();
    broadcast();
    log(`Auto-tagged P${side}: ${character}${costume >= 0 ? ` (costume ${costume + 1})` : ''} via ${kind} (${score.toFixed(2)})`);
  },
  onReview: (item) => trainer.enqueue(item),
});
const trainer = new Trainer({ dataDir: DATA_DIR, obs, detector, getCfg: () => cfg, log, onChange: () => broadcastTrain() });
function broadcastTrain() {
  const payload = { train: trainer.status(), detect: detector.status() };
  for (const c of sseClients) sseSend(c, 'train', payload);
  broadcast();
}
// ---------- stream overlay in OBS ----------
const OVERLAY_INPUT = 'TEC Overlay';
function overlayUrl() { return `http://localhost:${cfg.port || 8420}/overlay`; }
async function overlayStatus() {
  const out = { url: overlayUrl(), installed: false, scenes: [], inScenes: [], image: fs.existsSync(path.join(PUBLIC_DIR, 'overlay', 'overlay.png')) };
  if (obs.status !== 'connected') return out;
  try {
    out.scenes = (await obs.request('GetSceneList')).scenes.map((s) => s.sceneName).reverse();
    for (const sceneName of out.scenes) {
      const items = (await obs.request('GetSceneItemList', { sceneName })).sceneItems || [];
      if (items.some((i) => i.sourceName === OVERLAY_INPUT)) out.inScenes.push(sceneName);
    }
    out.installed = out.inScenes.length > 0;
  } catch { /* leave defaults */ }
  return out;
}
// Add the overlay page as a Browser Source at the top of a scene (the "Gameplay" scene by default).
async function installOverlay(sceneName) {
  if (obs.status !== 'connected') throw new Error('OBS is not connected');
  const scenes = (await obs.request('GetSceneList')).scenes.map((s) => s.sceneName);
  const target = sceneName && scenes.includes(sceneName) ? sceneName
    : scenes.find((s) => /gameplay|game/i.test(s)) || (await obs.request('GetCurrentProgramScene')).currentProgramSceneName;
  const inputs = (await obs.request('GetInputList')).inputs.map((i) => i.inputName);
  const settings = { url: overlayUrl(), width: 1920, height: 1080, fps_custom: false, shutdown: false, restart_when_active: false, reroute_audio: false };
  let sceneItemId;
  const existing = ((await obs.request('GetSceneItemList', { sceneName: target })).sceneItems || []).find((i) => i.sourceName === OVERLAY_INPUT);
  if (existing) {
    sceneItemId = existing.sceneItemId;
    await obs.request('SetInputSettings', { inputName: OVERLAY_INPUT, inputSettings: settings });
  } else if (inputs.includes(OVERLAY_INPUT)) {
    await obs.request('SetInputSettings', { inputName: OVERLAY_INPUT, inputSettings: settings });
    sceneItemId = (await obs.request('CreateSceneItem', { sceneName: target, sourceName: OVERLAY_INPUT, sceneItemEnabled: true })).sceneItemId;
  } else {
    sceneItemId = (await obs.request('CreateInput', { sceneName: target, inputName: OVERLAY_INPUT, inputKind: 'browser_source', inputSettings: settings, sceneItemEnabled: true })).sceneItemId;
  }
  // Top of the stack so nothing added later covers the names.
  const count = ((await obs.request('GetSceneItemList', { sceneName: target })).sceneItems || []).length;
  await obs.request('SetSceneItemIndex', { sceneName: target, sceneItemId, sceneItemIndex: Math.max(0, count - 1) });
  await obs.request('SetSceneItemTransform', { sceneName: target, sceneItemId, sceneItemTransform: { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1 } }).catch(() => {});
  cfg.overlay.scene = target;
  writeJson(CONFIG_PATH, cfg);
  log(`Overlay added to OBS scene "${target}"`);
  return { ok: true, scene: target, url: overlayUrl() };
}
// OBS reports the recordings folder while connected; keep the last one so tools work with OBS closed.
function recordDirectory() {
  return obs.recordDirectory || cfg.lastRecordDirectory || '';
}
function safeFileName(name) {
  const s = String(name || '');
  if (!s || s.includes('/') || s.includes(String.fromCharCode(92)) || s.includes('..')) return '';
  return s;
}
async function handleDetectApi(route, req, res, url) {
  switch (route) {
    case 'GET /api/detect/status':
      sendJson(res, 200, { detect: detector.status(), train: trainer.status() });
      return true;
    case 'GET /api/detect/sources': {
      let inputs = [];
      let scenes = [];
      try { inputs = (await obs.request('GetInputList')).inputs.map((i) => ({ name: i.inputName, kind: i.inputKind })); } catch { inputs = []; }
      try { scenes = (await obs.request('GetSceneList')).scenes.map((s) => s.sceneName); } catch { scenes = []; }
      sendJson(res, 200, { inputs, scenes });
      return true;
    }
    case 'GET /api/templates':
      sendJson(res, 200, { summary: detector.store.summary(), items: detector.store.items.map(({ mask, ...t }) => t) });
      return true;
    case 'POST /api/templates/remove': {
      const { id } = await readBody(req);
      sendJson(res, 200, { ok: detector.store.remove(String(id)) });
      broadcastTrain();
      return true;
    }
    case 'GET /api/train/videos':
      sendJson(res, 200, trainer.listVideos());
      return true;
    case 'GET /api/train/queue':
      sendJson(res, 200, { pending: trainer.pending(), status: trainer.status(), templates: detector.store.summary() });
      return true;
    case 'POST /api/train/scan': {
      const body = await readBody(req);
      try {
        await trainer.startScan(String(body.path || ''), { strideMs: Number(body.strideMs) || 2500, startSec: Number(body.startSec) || 0, lanes: Number(body.lanes) || 4 });
        sendJson(res, 200, { ok: true });
      } catch (e) { sendJson(res, 409, { error: e.message }); }
      return true;
    }
    case 'POST /api/train/cancel':
      trainer.cancelScan();
      sendJson(res, 200, { ok: true });
      return true;
    case 'POST /api/train/confirm': {
      const body = await readBody(req);
      try { sendJson(res, 200, { ok: true, item: trainer.confirm(String(body.id), { isVs: body.isVs !== false, p1: body.p1, p2: body.p2 }) }); }
      catch (e) { sendJson(res, 400, { error: e.message }); }
      return true;
    }
    case 'POST /api/train/skip': {
      const { id } = await readBody(req);
      try { sendJson(res, 200, { ok: true, item: trainer.skip(String(id)) }); } catch (e) { sendJson(res, 400, { error: e.message }); }
      return true;
    }
    case 'POST /api/train/clear-reviewed':
      trainer.clearReviewed();
      sendJson(res, 200, { ok: true });
      return true;
    case 'GET /api/train/image': {
      const dir = url.searchParams.get('dir') === 'templates' ? detector.store.dir : detector.samplesDir;
      const file = safeFileName(url.searchParams.get('file'));
      const full = file ? path.join(dir, file) : '';
      if (!full || !full.startsWith(dir) || !fs.existsSync(full)) { sendJson(res, 404, { error: 'not found' }); return true; }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(full));
      return true;
    }
    case 'GET /api/overlay/status': {
      sendJson(res, 200, await overlayStatus());
      return true;
    }
    case 'POST /api/overlay/install': {
      const body = await readBody(req);
      try { sendJson(res, 200, await installOverlay(String(body.scene || ''))); }
      catch (e) { sendJson(res, 400, { error: e.message }); }
      return true;
    }
    case 'POST /api/overlay/remove': {
      try { await obs.request('RemoveInput', { inputName: OVERLAY_INPUT }); } catch (e) { if (!/not found|does not exist/i.test(e.message)) { sendJson(res, 400, { error: e.message }); return true; } }
      sendJson(res, 200, { ok: true });
      return true;
    }
    case 'POST /api/current/score': {
      // +1 / -1 on one side of the scoreboard (wins in the set).
      const { side, delta } = await readBody(req);
      const key = Number(side) === 2 ? 'score2' : 'score1';
      state.current[key] = clampScore((state.current[key] || 0) + (Number(delta) || 0));
      persistState();
      broadcast();
      sendJson(res, 200, { ok: true, score1: state.current.score1, score2: state.current.score2 });
      return true;
    }
    case 'POST /api/recorded/toggle': {
      // Undo (or set) the "recorded" mark on a set, e.g. after a test recording against a real bracket.
      const { setId } = await readBody(req);
      const id = String(setId || '');
      if (!id) { sendJson(res, 400, { error: 'setId required' }); return true; }
      const had = state.recordedSetIds.includes(id);
      state.recordedSetIds = had ? state.recordedSetIds.filter((x) => x !== id) : [...state.recordedSetIds, id];
      persistState();
      broadcast();
      sendJson(res, 200, { ok: true, recorded: !had });
      return true;
    }
    // Post-event upload package for the YouTube Studio helper (served with CORS so studio.youtube.com can read it).
    case 'GET /api/upload-package': {
      const ev = String(url.searchParams.get('event') || '');
      const dir = ev && recordDirectory() ? path.join(recordDirectory(), sanitizeFilename(ev), '_upload') : '';
      if (!dir || !fs.existsSync(path.join(dir, 'upload-manifest.csv'))) { sendJson(res, 404, { error: 'No upload package for that event' }); return true; }
      const lines = fs.readFileSync(path.join(dir, 'upload-manifest.csv'), 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).slice(1);
      const parse = (line) => {
        const out = []; let cur = ''; let q = false;
        for (let i = 0; i < line.length; i += 1) {
          const ch = line[i];
          if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') q = false; else cur += ch; }
          else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
        }
        out.push(cur);
        return out;
      };
      const thumbs = fs.existsSync(path.join(dir, 'thumbnails')) ? fs.readdirSync(path.join(dir, 'thumbnails')).filter((f) => f.endsWith('.png')) : [];
      const items = lines.map(parse).map((r) => {
        const n = String(r[0]).padStart(2, '0');
        const thumb = thumbs.find((t) => t.startsWith(`${n} - `));
        let description = '';
        try { description = fs.readFileSync(path.join(dir, 'descriptions', r[14]), 'utf8'); } catch { description = ''; }
        return {
          n: Number(r[0]), title: r[1].replace(/\.mp4$/i, ''), description,
          thumbnailUrl: thumb ? `http://localhost:${cfg.port || 8420}/api/upload-package/thumb?event=${encodeURIComponent(ev)}&file=${encodeURIComponent(thumb)}` : null,
        };
      });
      const body = JSON.stringify(items);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      res.end(body);
      return true;
    }
    case 'GET /api/upload-package/thumb': {
      const ev = String(url.searchParams.get('event') || '');
      const file = safeFileName(url.searchParams.get('file'));
      const full = ev && file && recordDirectory() ? path.join(recordDirectory(), sanitizeFilename(ev), '_upload', 'thumbnails', file) : '';
      if (!full || !fs.existsSync(full)) { sendJson(res, 404, { error: 'not found' }); return true; }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(full));
      return true;
    }
    case 'POST /api/startgg/import': {
      const body = await readBody(req);
      try { sendJson(res, 200, { ok: true, ...(await importTournament(String(body.url || ''))) }); }
      catch (e) { sendJson(res, 400, { error: e.message }); }
      return true;
    }
    default:
      return false;
  }
}

// ---------- character art packs (downloaded on demand, never shipped) ----------
let artJob = null;
function artStatus() {
  return { portrait: art.packStatus(DATA_DIR, 'portrait'), icon: art.packStatus(DATA_DIR, 'icon'), job: artJob, source: art.SOURCE_URL };
}
function startArtDownload(pack) {
  if (artJob && artJob.running) throw new Error('A download is already running');
  artJob = { pack, running: true, total: 0, done: 0, failed: 0, error: '', startedAt: nowIso() };
  broadcast();
  let lastSent = 0;
  art.downloadPack(DATA_DIR, pack, (prog) => {
    Object.assign(artJob, prog);
    if (prog.done - lastSent >= 40) { lastSent = prog.done; broadcast(); }
  })
    .then((r) => { Object.assign(artJob, r, { running: false }); const n = detector.reloadArt(); log(`Character art: ${r.done} files in ${r.dir} (${n} portraits loaded)`); })
    .catch((e) => { artJob.running = false; artJob.error = e.message; log('Character art download failed:', e.message); })
    .finally(() => broadcast());
}

// ---------- dashboard access ----------
// The dashboard listens on localhost only unless network.lan is on. Requests from other devices then need the PIN:
// the dashboard stores it as a cookie after POST /api/pin; the overlay page can carry it as ?pin= in its URL.
const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function isLocalRequest(req) { return LOCAL_ADDRESSES.has(req.socket.remoteAddress || ''); }
function pinMatches(given) {
  const pin = String((cfg.network && cfg.network.pin) || '');
  const g = String(given || '');
  return pin.length > 0 && g.length === pin.length && crypto.timingSafeEqual(Buffer.from(g), Buffer.from(pin));
}
function requestHasPin(req, url) {
  if (!cfg.network || !cfg.network.pin) return true;
  const cookie = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith('tec_pin='));
  const given = url.searchParams.get('pin') || req.headers['x-pin'] || (cookie ? decodeURIComponent(cookie.slice(8)) : '');
  return pinMatches(given);
}
function listenHost() { return cfg.network && cfg.network.lan ? '0.0.0.0' : '127.0.0.1'; }
function rebindServer() {
  for (const c of sseClients) { try { c.end(); } catch { /* already gone */ } }
  sseClients.clear();
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close(() => server.listen(cfg.port, listenHost(), () => {
    log(`Dashboard now ${cfg.network.lan ? 'open to this network' : 'on this PC only'} (${listenHost()}:${cfg.port})`);
    for (const u of (cfg.network.lan ? lanUrls() : [])) log(`  also on this network: ${u}`);
  }));
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case 'GET /api/state': return sendJson(res, 200, snapshot());
    case 'GET /api/bracket': return sendJson(res, 200, bracketPayload());
    case 'GET /api/fighters': return sendJson(res, 200, readJson(FIGHTERS_PATH, []));
    case 'GET /api/log': return sendJson(res, 200, state.log);
    case 'GET /api/config': return sendJson(res, 200, publicConfig());
    case 'GET /api/events': {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      sseSend(res, 'state', snapshot());
      sseSend(res, 'bracket', bracketPayload());
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return undefined;
    }
    case 'PUT /api/config':
      updateConfig(await readBody(req));
      return sendJson(res, 200, { ok: true, config: publicConfig() });
    case 'PATCH /api/current':
      patchCurrent(await readBody(req));
      return sendJson(res, 200, { ok: true, current: state.current, preview: buildLabel(state.current) });
    case 'POST /api/current/clear':
      // The set format (Bo1/Bo3/Bo5) is a property of the day, not the set, so it survives a clear.
      state.current = { ...emptyCurrent(), bestOf: state.current.bestOf || 1 };
      detector.resetLocks();
      persistState();
      broadcast();
      return sendJson(res, 200, { ok: true });
    case 'POST /api/current/swap': {
      const c = state.current;
      [c.p1, c.p2] = [c.p2, c.p1];
      [c.chars1, c.chars2] = [c.chars2, c.chars1];
      [c.auto1, c.auto2] = [c.auto2 || [], c.auto1 || []];
      [c.score1, c.score2] = [c.score2 || 0, c.score1 || 0];
      [c.wins1, c.wins2] = [c.wins2 || 0, c.wins1 || 0];
      persistState();
      broadcast();
      return sendJson(res, 200, { ok: true, current: state.current });
    }
    case 'POST /api/select-set': {
      const { id } = await readBody(req);
      const s = bracket.sets.find((x) => x.id === String(id));
      if (!s) return sendJson(res, 404, { error: 'Set not found' });
      selectSet(s);
      return sendJson(res, 200, { ok: true, current: state.current });
    }
    case 'POST /api/record/start':
      try { await startRecording(); return sendJson(res, 200, { ok: true, rec: state.rec }); } catch (e) { return sendJson(res, 409, { error: e.message }); }
    case 'POST /api/record/stop':
      try { const entry = await stopRecording(); return sendJson(res, 200, { ok: true, entry }); } catch (e) { return sendJson(res, 409, { error: e.message }); }
    case 'POST /api/startgg/sync':
      syncStartgg();
      return sendJson(res, 200, { ok: true });
    case 'POST /api/log/retry': {
      const { id } = await readBody(req);
      const entry = state.log.find((x) => x.id === id);
      if (!entry) return sendJson(res, 404, { error: 'Entry not found' });
      if (entry.status === 'saving') return sendJson(res, 409, { error: 'Already saving' });
      finalizeEntry(entry);
      return sendJson(res, 200, { ok: true });
    }
    case 'POST /api/pin': {
      const { pin } = await readBody(req);
      if (!pinMatches(pin)) return sendJson(res, 401, { error: 'Wrong PIN', pinRequired: true });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `tec_pin=${encodeURIComponent(pin)}; Path=/; SameSite=Lax; Max-Age=2592000` });
      return res.end('{"ok":true}');
    }
    case 'GET /api/art/status': return sendJson(res, 200, artStatus());
    case 'POST /api/art/download': {
      const { pack = 'portrait' } = await readBody(req);
      try { startArtDownload(pack); } catch (e) { return sendJson(res, 409, { error: e.message }); }
      return sendJson(res, 200, { ok: true, art: artStatus() });
    }
    case 'POST /api/open-folder':
      return sendJson(res, 200, { ok: true, dir: openFolder() });
    default:
      if (await handleDetectApi(route, req, res, url)) return undefined;
      return sendJson(res, 404, { error: `No route ${route}` });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/pin' && !isLocalRequest(req) && !requestHasPin(req, url)) {
      return sendJson(res, 401, { error: 'This dashboard needs the PIN from Settings on the recording PC', pinRequired: true });
    }
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(res, url.pathname);
  } catch (e) {
    log('Request failed:', e.message);
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
  }
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${cfg.port} is already in use. Is the recorder already running?`);
  else console.error('Server error:', e.message);
  process.exit(1);
});

// ---------- startup ----------
process.on('uncaughtException', (e) => log('Unexpected error:', e));
process.on('unhandledRejection', (e) => log('Unexpected error:', e));

fs.mkdirSync(DATA_DIR, { recursive: true });
for (const entry of state.log) {
  if (entry.status === 'saving') { entry.status = 'error'; entry.error = 'The app was restarted before this file was renamed'; }
}
setTimeout(() => {
  for (const entry of state.log) {
    if (entry.status === 'error' && entry.sourcePath && fs.existsSync(entry.sourcePath)) finalizeEntry(entry);
  }
}, 3000);

server.listen(cfg.port, listenHost(), () => {
  log(`TEC Match Recorder: dashboard at http://localhost:${cfg.port}`);
  if (cfg.network.lan) for (const u of lanUrls()) log(`  also on this network: ${u} (PIN required)`);
  else log('  other devices cannot open it; turn on network access in Settings if you need a phone or a second laptop');
  obs.connect();
  schedulePoll();
  syncStartgg();
  checkDisk();
  setInterval(checkDisk, 30000);
  detector.start();
  if (OPEN_BROWSER && process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', `http://localhost:${cfg.port}`], { detached: true, stdio: 'ignore' }).unref();
  }
});
