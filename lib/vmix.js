'use strict';
/*
 * vMix client: the HTTP API that vMix serves once its Web Controller is on (Settings, Web Controller,
 * port 8088 by default). vMix pushes nothing over HTTP, so the client reads the XML state once a second
 * and turns changes in <recording> into the same start/stop events the OBS client raises.
 *
 * The recorder asks it for: recording on/off and the file vMix is writing (the filename1 attribute of
 * <recording>), the inputs list (detector sources, the overlay input), the overlay channels, and input
 * snapshots for the character detector (written to a file, so only when vMix runs on this PC).
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const POLL_MS = 1000;
const VIDEO_EXT = /\.(mp4|mov|avi|mkv|ts|mxf|wmv|m4v)$/i;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const unescapeXml = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function attr(tag, name) {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag);
  return m ? unescapeXml(m[1]) : '';
}
function parseState(xml) {
  if (!/<vmix>/i.test(xml)) throw new Error('That port answered, but it is not vMix');
  const text = (tag) => { const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml); return m ? unescapeXml(m[1]).trim() : ''; };
  const rec = /<recording\b([^>]*?)(?:\/>|>([^<]*)<\/recording>)/.exec(xml);
  const recAttrs = rec ? rec[1] : '';
  // Input layers are <overlay index=".." key=".."/> inside an <input>; the channels are <overlay number="..">.
  const overlays = [...xml.matchAll(/<overlay\b([^>]*?)(?:\/>|>([^<]*)<\/overlay>)/g)]
    .filter((m) => attr(m[1], 'number'))
    .map((m) => ({ number: Number(attr(m[1], 'number')), input: (m[2] || '').trim() }));
  return {
    version: text('version'),
    edition: text('edition'),
    recording: !!rec && /true/i.test(rec[2] || ''),
    durationSec: Number(attr(recAttrs, 'duration')) || 0,
    file: attr(recAttrs, 'filename1'),
    inputs: [...xml.matchAll(/<input\b([^>]*)>/g)].map((m) => ({
      key: attr(m[1], 'key'), number: Number(attr(m[1], 'number')), type: attr(m[1], 'type'), title: attr(m[1], 'title'),
    })),
    overlays,
    active: Number(text('active')) || 0,
  };
}
function isThisPc(host) {
  const h = String(host || '').trim().toLowerCase();
  if (!h || h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
  return Object.values(os.networkInterfaces()).some((list) => (list || []).some((a) => a.address.toLowerCase() === h));
}

class VmixClient {
  constructor({ getCfg, log }) {
    this.getCfg = getCfg;
    this.log = log;
    this.gen = 0;
    this.timer = null;
    this.status = 'disconnected';
    this.lastError = '';
    this.version = '';
    this.recording = false;
    this.recordDirectory = '';
    this.file = '';
    this.startedAt = 0;
    this.inputs = [];
    this.overlays = [];
    this.handlers = { event: [], status: [] };
  }
  on(kind, fn) { this.handlers[kind].push(fn); }
  emit(kind, payload) {
    for (const fn of this.handlers[kind]) {
      try { fn(payload); } catch (e) { this.log('handler error:', e); }
    }
  }
  setStatus(status, error = '') {
    if (this.status === status && this.lastError === error) return;
    this.status = status;
    this.lastError = error;
    this.emit('status', status);
  }
  conf() { return this.getCfg().vmix || {}; }
  base() { const c = this.conf(); return `http://${c.host || '127.0.0.1'}:${Number(c.port) || 8088}`; }
  headers() {
    const c = this.conf();
    return c.password || c.user ? { Authorization: `Basic ${Buffer.from(`${c.user || ''}:${c.password || ''}`).toString('base64')}` } : {};
  }
  // Snapshots are files vMix writes on its own PC, so the detector can only read them when that is this PC.
  canSnapshot() { return isThisPc(this.conf().host); }

  connect() {
    clearTimeout(this.timer);
    this.gen += 1;
    this.recording = false;
    this.setStatus('connecting');
    this.poll(this.gen);
  }
  disconnect() {
    clearTimeout(this.timer);
    this.gen += 1;
    this.recording = false;
    this.setStatus('disconnected', '');
  }
  async poll(gen) {
    try {
      await this.refresh(gen);
    } catch (e) {
      if (gen !== this.gen) return;
      this.recording = false;
      if (e.status === 401) this.setStatus('auth-failed', 'vMix wants a user name and password: use the ones from vMix Settings, Web Controller.');
      else this.setStatus('disconnected', e.network ? 'vMix is not running, or its Web Controller is off (vMix: Settings, Web Controller, tick Enable).' : e.message);
    } finally {
      if (gen === this.gen) this.timer = setTimeout(() => this.poll(gen), this.status === 'connected' ? POLL_MS : 3000);
    }
  }
  async get(url, timeoutMs = 4000) {
    let res;
    try {
      res = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const err = new Error(`vMix did not answer at ${this.base()}`);
      err.network = true;
      throw err;
    }
    const body = await res.text();
    if (!res.ok) {
      const err = new Error(res.status === 401 ? 'vMix rejected the user name or password' : `vMix: ${body.trim().slice(0, 200) || `HTTP ${res.status}`}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }
  // Read the XML state and raise events for what changed since the last read.
  async refresh(gen = this.gen) {
    const st = parseState(await this.get(`${this.base()}/api`));
    if (gen !== this.gen) return st;
    const wasConnected = this.status === 'connected';
    const wasRecording = this.recording;
    this.version = st.version;
    this.inputs = st.inputs;
    this.overlays = st.overlays;
    this.recording = st.recording;
    if (st.file) {
      this.file = st.file;
      this.recordDirectory = path.dirname(st.file);
    }
    if (!wasConnected) {
      this.setStatus('connected');
      if (st.recording) { this.startedAt = Date.now() - st.durationSec * 1000; this.file = st.file; }
      this.log(`Connected to vMix ${st.version}${st.edition ? ` ${st.edition}` : ''}${this.recordDirectory ? `, recordings go to ${this.recordDirectory}` : ''}`);
      this.emit('event', { type: 'ready', recording: st.recording, durationMs: st.durationSec * 1000 });
    } else if (st.recording && !wasRecording) {
      this.startedAt = Date.now() - st.durationSec * 1000;
      this.file = st.file;
      this.emit('event', { type: 'record', state: 'started', active: true, path: st.file || null });
    } else if (!st.recording && wasRecording) {
      // <recording> drops filename1 once it stops, so this is the name seen while it ran.
      const file = this.file || (await this.findRecording());
      this.emit('event', { type: 'record', state: 'stopped', active: false, path: file || null });
    }
    return st;
  }
  async call(fn, params = {}, timeoutMs = 8000) {
    if (this.status !== 'connected') throw new Error('vMix is not connected');
    const q = new URLSearchParams({ Function: fn });
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
    return this.get(`${this.base()}/api/?${q}`, timeoutMs);
  }
  async waitFor(test, ms) {
    const end = Date.now() + ms;
    for (;;) {
      const st = await this.refresh();
      if (test(st)) return st;
      if (Date.now() > end) return null;
      await sleep(250);
    }
  }

  // ---------- recording (same shape as the OBS client's) ----------
  async recordStatus() {
    const st = await this.refresh();
    return { active: st.recording, durationMs: st.durationSec * 1000 };
  }
  async startRecord() {
    this.file = '';
    await this.call('StartRecording');
    const st = await this.waitFor((s) => s.recording, 8000);
    if (!st) throw new Error('vMix did not start recording. Check the folder and format under vMix Settings, Recording.');
  }
  // Stops and returns the path of the file vMix wrote ('' if it could not be found).
  async stopRecord() {
    const before = await this.refresh();
    if (!before.recording) throw new Error('vMix is not recording');
    const file = before.file || this.file;
    await this.call('StopRecording');
    const st = await this.waitFor((s) => !s.recording, 30000);
    if (!st) throw new Error('vMix did not stop recording within 30 seconds');
    return file || (await this.findRecording());
  }
  // vMix versions that do not report filename1: the newest video in the known recordings folder
  // that was written since this recording began.
  async findRecording(startedAt = this.startedAt) {
    const dir = this.recordDirectory || this.conf().recordDirectory || '';
    if (!dir) return '';
    try {
      const since = (startedAt || Date.now()) - 10000;
      let best = null;
      for (const name of await fsp.readdir(dir)) {
        if (!VIDEO_EXT.test(name)) continue;
        const full = path.join(dir, name);
        const s = await fsp.stat(full);
        if (s.isFile() && s.mtimeMs >= since && (!best || s.mtimeMs > best.mtime)) best = { full, mtime: s.mtimeMs };
      }
      return best ? best.full : '';
    } catch { return ''; }
  }

  // ---------- frames for the character detector ----------
  async screenshot(sourceName) {
    if (!this.canSnapshot()) throw new Error('vMix runs on another PC, so its snapshots cannot be read here');
    const file = path.join(os.tmpdir(), `tec-recorder-vmix-${crypto.randomUUID()}.png`);
    try {
      if (sourceName) await this.call('SnapshotInput', { Input: sourceName, Value: file });
      else await this.call('Snapshot', { Value: file });
      // vMix writes the file a moment after answering; wait until it is there and has stopped growing.
      let last = -1;
      for (let i = 0; i < 40; i += 1) {
        await sleep(100);
        let size = -1;
        try { size = fs.statSync(file).size; } catch { /* not yet */ }
        if (size > 0 && size === last) break;
        last = size;
      }
      const buf = await fsp.readFile(file);
      if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('vMix wrote a snapshot that is not a PNG');
      return buf;
    } finally {
      fsp.unlink(file).catch(() => {});
    }
  }
  async listSources() {
    await this.refresh();
    return { inputs: this.inputs.map((i) => ({ name: i.title, kind: i.type })), scenes: [] };
  }

  // ---------- stream overlay: a Browser input on an overlay channel ----------
  findInput(title) { return this.inputs.find((i) => i.title === title) || null; }
  channelOf(input) {
    if (!input) return 0;
    const o = this.overlays.find((c) => c.input && (c.input === String(input.number) || c.input === input.key));
    return o ? o.number : 0;
  }
  async overlayState(title) {
    await this.refresh();
    const input = this.findInput(title);
    return { installed: !!input, channel: this.channelOf(input), number: input ? input.number : 0 };
  }
  // Adds (or re-points) the Browser input and puts it on an overlay channel: the one asked for,
  // else the first free one. Overlay channels sit on top of whatever is in Program.
  async installOverlay({ title, url, channel = 0 }) {
    await this.refresh();
    let input = this.findInput(title);
    if (!input) {
      const before = new Set(this.inputs.map((i) => i.key));
      await this.call('AddInput', { Value: `Browser|${url}` });
      const st = await this.waitFor((s) => s.inputs.some((i) => !before.has(i.key)), 5000);
      input = st && st.inputs.find((i) => !before.has(i.key));
      if (!input) throw new Error('vMix did not add the Browser input');
      await this.call('SetInputName', { Input: input.key, Value: title });
    } else {
      await this.call('BrowserNavigate', { Input: input.key, Value: url });
    }
    const wanted = Math.min(4, Math.max(0, Number(channel) || 0));
    let ch = this.channelOf(input);
    if (!ch || (wanted && ch !== wanted)) {
      // Moving channels: take it off the old one so it is not drawn twice.
      if (ch) await this.call(`OverlayInput${ch}Out`).catch(() => {});
      ch = wanted || (this.overlays.find((o) => !o.input) || {}).number || 0;
      if (!ch) throw new Error('All vMix overlay channels are in use. Free one, or pick a channel in Settings.');
      await this.call(`OverlayInput${ch}In`, { Input: input.key });
    }
    await this.refresh();
    return { input: title, number: input.number, channel: ch };
  }
  async removeOverlay(title) {
    await this.refresh();
    const input = this.findInput(title);
    if (!input) return false;
    await this.call('RemoveInput', { Input: input.key });
    await this.refresh();
    return true;
  }
}

module.exports = { VmixClient, parseState };
