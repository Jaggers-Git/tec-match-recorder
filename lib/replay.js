'use strict';
/*
 * Instant replay.
 *
 * OBS: its Replay Buffer keeps the last N seconds of the encoded output in memory (the recording encoder,
 * so there is no second encode). The operator ticks "Enable Replay Buffer" once in OBS; the recorder sets
 * the length, keeps the buffer running, and on REPLAY asks OBS to save it. Every save (the dashboard, OBS's
 * own hotkey, a Stream Deck) arrives as ReplayBufferSaved and lands in one event list, filed into the
 * event's Replays folder and named after the set. Playback loads the clip into a Media Source in the
 * "TEC Replay" scene at the chosen speed and sends that scene to Preview or Program like any scene button;
 * when the clip ends the scene that was live before goes back to air.
 *
 * vMix: its own Instant Replay (4K, Pro and MAX editions) records to disk; REPLAY marks the last N
 * seconds as an event, exports it into the Replays folder when vMix runs on this PC, and Play sends the
 * newest event to the output at the chosen speed. vMix replay has not been tested on a live vMix.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SCENE = 'TEC Replay';
const CLIP = 'TEC Replay Clip';
const BADGE = 'TEC Replay Badge';
// OBS's built-in Color Correction filter on the clip: a little less colour tells viewers the moment
// already happened (Settings, Instant replay, replay.fade). The badge above it keeps its full colour.
const FADE = 'TEC Replay Fade';
const FADE_SETTINGS = { saturation: -0.4, contrast: -0.05 };
const VIDEO_EXT = /\.(mp4|mov|mkv|flv|ts|m4v|avi|mxf)$/i;
const MAX_EVENTS = 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pad = (n) => String(n).padStart(2, '0');
const clampSpeed = (n) => Math.max(10, Math.min(100, Math.round(Number(n) || 50)));
const localDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
async function waitFor(test, ms) {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await sleep(100);
  return test();
}

// Media Source settings for the replay clip. restart_on_activate: a clip waiting in Studio Mode's Preview
// starts from its first frame the moment it is taken live.
function clipSettings(file, speed) {
  return {
    is_local_file: true, local_file: file || '', looping: false, restart_on_activate: true,
    close_when_inactive: false, hw_decode: true, clear_on_media_end: false, speed_percent: clampSpeed(speed),
  };
}
const browserSettings = (url) => ({ url, width: 1920, height: 1080, fps_custom: false, shutdown: false, restart_when_active: false, reroute_audio: false });

// Rename, retrying while another program still holds the file (Windows reports EBUSY or EPERM).
async function moveWithRetry(src, target, maxMs = 30000) {
  const end = Date.now() + maxMs;
  let last = null;
  while (Date.now() < end) {
    try {
      await fsp.rename(src, target);
      return target;
    } catch (e) {
      last = e;
      if (e.code === 'EXDEV') { await fsp.copyFile(src, target); await fsp.unlink(src); return target; }
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e;
    }
    await sleep(500);
  }
  throw last || new Error('could not move the clip');
}

class Replay {
  constructor({ getCfg, saveConfig, log, onChange, obs, vmix, getSw, current, eventName, recordDirectory, files, sendScene, scenesTo, initial, initialQueue }) {
    Object.assign(this, { getCfg, saveConfig, log, onChange, obs, vmix, getSw, current, eventName, recordDirectory, files, sendScene, scenesTo });
    this.events = (Array.isArray(initial) ? initial : []).filter((e) => e && e.id).slice(0, MAX_EVENTS);
    // The on-air queue: clip ids in play order, kept across restarts. `playlist` is a queue being played.
    this.queue = (Array.isArray(initialQueue) ? initialQueue : []).filter((id) => this.events.some((e) => e.id === id));
    this.playlist = null;
    this.loadedAt = 0;
    // A clip the app was filing when it closed is still playable from where OBS wrote it.
    for (const e of this.events) {
      if (e.status !== 'saving') continue;
      if (e.sourcePath && fs.existsSync(e.sourcePath)) Object.assign(e, { status: 'saved', path: e.sourcePath, filename: path.basename(e.sourcePath) });
      else Object.assign(e, { status: 'error', error: 'The recorder restarted before this clip was filed' });
    }
    this.available = null;     // null until the production software has answered
    this.active = false;       // OBS: the buffer is running; vMix: the replay input is recording
    this.reason = '';          // why replay is not available
    this.saving = false;
    this.lastError = '';
    this.lastSaveAt = 0;
    this.pending = [];         // set details of presses waiting for OBS's ReplayBufferSaved
    this.waiters = [];
    this.playing = null;
    this.returnTo = '';
    this.cueBefore = '';
    this.obsState = '';        // the buffer's last reported state: 'started', 'stopped', or OBS's in-between name
    this.sceneInstalled = false;
    this.syncing = false;
    this.resync = false;
    this.playTimer = null;
  }
  changed() { this.onChange(); }
  isObs() { return this.getSw() === this.obs; }
  conf() { return this.getCfg().replay; }
  // Whether the recorder keeps the buffer running now: in Broadcast mode, and in Record mode only when
  // Settings asks for it (Save clip). With x264 an idle buffer keeps a CPU encoder busy all day.
  wanted() {
    const c = this.conf();
    return !!c.enabled && (this.getCfg().mode === 'broadcast' || !!c.inRecord);
  }
  // Which encoder the recording (and so the replay buffer) uses, read from the OBS profile.
  async readEncoder() {
    const p = async (cat, name) => {
      const r = await this.obs.request('GetProfileParameter', { parameterCategory: cat, parameterName: name });
      return String(r.parameterValue ?? r.defaultParameterValue ?? '');
    };
    try {
      let enc;
      if ((await p('Output', 'Mode')).toLowerCase() === 'advanced') {
        enc = await p('AdvOut', 'RecEncoder');
        if (!enc || enc === 'none') enc = await p('AdvOut', 'Encoder'); // "Use stream encoder"
      } else {
        enc = (await p('SimpleOutput', 'RecQuality')) === 'Stream' ? await p('SimpleOutput', 'StreamEncoder') : await p('SimpleOutput', 'RecEncoder');
      }
      this.encoder = enc;
      this.cpuEncoder = /x264/i.test(enc);
    } catch {
      this.encoder = '';
      this.cpuEncoder = null;
    }
  }

  // The clip list as pages see it (the newest 100, without the internal fields).
  eventList() { return this.events.slice(0, 100).map(({ sourcePath, key, ...e }) => e); }
  // events: false leaves the clip list out, for the state that goes to every page on each change.
  status({ events = true } = {}) {
    const c = this.conf();
    const sw = this.getSw();
    const connected = sw.status === 'connected';
    return {
      sw: this.isObs() ? 'obs' : 'vmix',
      connected,
      available: connected ? this.available : null,
      active: connected && this.active,
      reason: this.reason,
      enabled: c.enabled, seconds: c.seconds, speed: c.speed, autoReturn: c.autoReturn, audio: c.audio, inRecord: !!c.inRecord,
      wanted: this.wanted(), encoder: this.encoder || '', cpuEncoder: this.cpuEncoder ?? null,
      saving: this.saving,
      lastError: this.lastError,
      playing: this.playing ? { ...this.playing, onAir: this.isObs() ? this.obs.program === SCENE : true } : null,
      queue: this.queue,
      playlist: this.playlist ? { index: this.playlist.index, total: this.playlist.ids.length } : null,
      returnTo: this.returnTo,
      scene: { name: SCENE, installed: this.isObs() && this.sceneInstalled },
      ...(events ? { events: this.eventList() } : {}),
    };
  }

  // ---------- connection and settings ----------
  reset() {
    this.available = null;
    this.active = false;
    this.startedByUs = false;
    this.reason = '';
    this.playing = null;
    this.returnTo = '';
    this.sceneInstalled = false;
  }
  async onReady() {
    this.playing = null;
    if (this.isObs()) {
      await this.checkScene();
      await this.syncObs();
      if (this.sceneInstalled) await this.syncFade();
    } else {
      this.vmixStartTried = false;
      await this.syncVmix();
    }
  }
  configChanged() {
    this.vmixStartTried = false;
    if (this.getSw().status !== 'connected') return;
    if (this.isObs()) { this.syncObs(); this.syncFade(); } else this.syncVmix();
  }
  // Puts the fade filter on the clip, or switches it off, to match Settings. A filter the operator
  // changed by hand in OBS keeps its own amounts while it is switched on.
  async syncFade() {
    if (!this.isObs() || this.obs.status !== 'connected') return;
    const want = this.conf().fade !== false;
    try {
      let filters;
      try { filters = (await this.obs.request('GetSourceFilterList', { sourceName: CLIP })).filters || []; } catch { return; } // no clip yet
      const have = filters.find((f) => f.filterName === FADE);
      if (!have) {
        if (want) await this.obs.request('CreateSourceFilter', { sourceName: CLIP, filterName: FADE, filterKind: 'color_filter_v2', filterSettings: FADE_SETTINGS });
      } else if (!!have.filterEnabled !== want) {
        await this.obs.request('SetSourceFilterEnabled', { sourceName: CLIP, filterName: FADE, filterEnabled: want });
      }
    } catch (e) { this.log(`Instant replay: could not ${want ? 'add' : 'switch off'} the colour fade (${e.message})`); }
  }
  // Where the clip on air is, for the countdown bar on the REPLAY badge (polled by /replay while a
  // replay plays). Cursor and duration are OBS's, in milliseconds of the clip itself.
  async progress() {
    const p = this.playing;
    if (!p || !this.isObs() || this.obs.status !== 'connected') return { playing: false };
    const out = { playing: true, id: p.id, at: p.at, speed: p.speed };
    try {
      const s = await this.obs.request('GetMediaInputStatus', { inputName: CLIP });
      return { ...out, state: String(s.mediaState || '').replace('OBS_MEDIA_STATE_', '').toLowerCase(), cursor: s.mediaCursor, duration: s.mediaDuration };
    } catch { return { ...out, state: 'unknown' }; }
  }
  async syncObs() {
    if (this.syncing) { this.resync = true; return; }
    this.syncing = true;
    const obs = this.obs;
    const c = this.conf();
    try {
      let st;
      try {
        st = await obs.request('GetReplayBufferStatus');
      } catch (e) {
        if (e.code === 604 || /not available/i.test(e.message)) {
          this.available = false;
          this.active = false;
          this.reason = 'OBS has no replay buffer yet. In OBS: Settings, Output, tick Enable Replay Buffer (in Advanced output mode it is on the Replay Buffer tab), then OK.';
          return;
        }
        throw e;
      }
      this.available = true;
      this.reason = '';
      this.lastError = '';
      this.active = !!st.outputActive;
      await this.readEncoder();
      if (!this.wanted()) {
        // Record mode (or replays switched off): stop a buffer the recorder started, never one started in OBS.
        if (this.active && this.startedByUs && !this.saving) {
          await obs.request('StopReplayBuffer');
          await this.waitActive(false, 10000);
          this.log('Instant replay: OBS replay buffer stopped (Record mode)');
        }
        this.startedByUs = false;
        return;
      }
      const len = await this.obsLength();
      if (len && len.seconds !== c.seconds) {
        if (this.active) {
          if (this.saving) { this.resync = true; return; }
          this.obsState = '';
          await obs.request('StopReplayBuffer');
          await this.waitActive(false, 10000);
          // "Not active" arrives while OBS is still stopping, and a start sent then is dropped without a word.
          await waitFor(() => this.obsState === 'stopped', 5000);
          await sleep(500);
        }
        await obs.request('SetProfileParameter', { parameterCategory: len.category, parameterName: 'RecRBTime', parameterValue: String(c.seconds) });
        this.log(`Instant replay: OBS replay buffer length set to ${c.seconds} seconds`);
      }
      if (!this.active) {
        for (let attempt = 1; attempt <= 3 && !this.active; attempt += 1) {
          try { await obs.request('StartReplayBuffer'); } catch (e) { if (e.code !== 500) throw e; } // 500: already running
          if (await this.waitActive(true, 4000)) break;
          await sleep(1000);
        }
        if (!this.active) throw new Error('OBS did not start the replay buffer. Start it under Controls in OBS (Start Replay Buffer)');
        this.startedByUs = true;
        this.log(`Instant replay: OBS replay buffer running (last ${c.seconds} seconds)`);
      }
    } catch (e) {
      this.lastError = e.message;
      this.log(`Instant replay: ${e.message}`);
    } finally {
      this.syncing = false;
      this.changed();
      if (this.resync) { this.resync = false; setTimeout(() => this.syncObs(), 1500); }
    }
  }
  async obsLength() {
    try {
      const mode = (await this.obs.request('GetProfileParameter', { parameterCategory: 'Output', parameterName: 'Mode' })).parameterValue;
      const category = String(mode || '').toLowerCase() === 'advanced' ? 'AdvOut' : 'SimpleOutput';
      const p = await this.obs.request('GetProfileParameter', { parameterCategory: category, parameterName: 'RecRBTime' });
      return { category, seconds: Number(p.parameterValue ?? p.defaultParameterValue) || 20 };
    } catch (e) {
      this.log(`Instant replay: could not read the OBS replay length (${e.message})`);
      return null;
    }
  }
  async waitActive(want, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.active === want) return true;
      await sleep(250);
      try { this.active = !!(await this.obs.request('GetReplayBufferStatus')).outputActive; } catch { /* keep the last value */ }
    }
    return this.active === want;
  }
  // The Start / Stop buttons in the setup checklist and the replay panel.
  async setBuffer(on) {
    if (!this.isObs()) {
      await this.vmix.call(on ? 'ReplayStartRecording' : 'ReplayStopRecording');
      this.active = !!on;
      this.changed();
      return;
    }
    if (this.available === false) throw new Error(this.reason);
    if (on) { await this.syncObsStart(); return; }
    await this.obs.request('StopReplayBuffer');
    await this.waitActive(false, 10000);
    this.changed();
  }
  async syncObsStart() {
    if (!this.wanted()) {
      // Started by hand where the recorder would not run it (replays off, or Record mode): start it once
      // without changing the setting, and leave stopping it to the operator.
      await this.obs.request('StartReplayBuffer');
      await this.waitActive(true, 10000);
      this.changed();
      return;
    }
    await this.syncObs();
    if (this.lastError) throw new Error(this.lastError);
  }

  // ---------- events from OBS and vMix ----------
  onSwitcherEvent(ev) {
    if (ev.type === 'replay-state') {
      if (this.isObs()) { this.active = !!ev.active; this.obsState = ev.state || ''; }
      else this.syncVmix();
      this.changed();
    } else if (ev.type === 'replay-saved') {
      this.onObsSaved(ev.path);
    } else if (ev.type === 'media-ended' && ev.input === CLIP) {
      this.onClipEnded();
    }
  }

  // ---------- saving ----------
  metaNow() {
    const c = this.current();
    const d = new Date();
    return {
      ts: d.toISOString(), date: localDate(d), time: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
      sw: this.isObs() ? 'obs' : 'vmix',
      setId: c.setId || '', set: c.setLetter || '', round: c.round || '', p1: c.p1 || '', p2: c.p2 || '',
      event: this.eventName() || '', key: c.setId || `${c.p1 || ''}|${c.p2 || ''}`,
    };
  }
  addEvent(meta, extra) {
    const n = this.events.filter((e) => e.date === meta.date && e.key === meta.key).length + 1;
    const players = meta.p1 || meta.p2 ? ` - ${meta.p1 || 'Player 1'} vs ${meta.p2 || 'Player 2'}` : '';
    const base = this.files.sanitizeFilename(`${meta.date} ${meta.set ? `${meta.set} ` : ''}Replay ${n}${players}`) || `${meta.date} Replay ${meta.time}`;
    const ev = { id: crypto.randomUUID(), ...meta, n, base, seconds: this.conf().seconds, star: false, path: '', filename: '', status: 'saving', error: '', ...extra };
    this.events.unshift(ev);
    if (this.events.length > MAX_EVENTS) this.events.length = MAX_EVENTS;
    this.changed();
    return ev;
  }
  async save() {
    if (this.saving) throw new Error('Still saving the last replay, one moment');
    // OBS names replays to the second, so two saves inside one second would overwrite each other.
    const gap = Date.now() - this.lastSaveAt;
    if (gap < 1100) await sleep(1100 - gap);
    this.saving = true;
    this.lastError = '';
    this.changed();
    try {
      return this.isObs() ? await this.saveObs() : await this.saveVmix();
    } catch (e) {
      this.lastError = e.message;
      throw e;
    } finally {
      this.lastSaveAt = Date.now();
      this.saving = false;
      this.changed();
    }
  }
  async saveObs() {
    if (this.obs.status !== 'connected') throw new Error('OBS is not connected');
    if (this.available === false) throw new Error(this.reason);
    if (!this.active) throw new Error('The OBS replay buffer is off. Press Start buffer in the replay panel, or Start Replay Buffer under Controls in OBS');
    const meta = this.metaNow();
    let resolveSaved;
    const saved = new Promise((resolve) => { resolveSaved = resolve; });
    this.pending.push(meta);
    this.waiters.push(resolveSaved);
    const forget = () => {
      this.pending = this.pending.filter((m) => m !== meta);
      this.waiters = this.waiters.filter((w) => w !== resolveSaved);
    };
    try {
      await this.obs.request('SaveReplayBuffer');
    } catch (e) { forget(); throw e; }
    const ev = await Promise.race([saved, sleep(20000).then(() => null)]);
    if (!ev) {
      forget();
      throw new Error('OBS did not save the replay. A paused recording blocks replay saves: resume it and try again');
    }
    return ev;
  }
  // Every OBS save lands here, the dashboard's and OBS's own hotkey alike.
  onObsSaved(savedPath) {
    const src = path.normalize(String(savedPath || ''));
    const meta = this.pending.shift() || this.metaNow();
    const ev = this.addEvent(meta, { sourcePath: src, status: 'saving' });
    const waiter = this.waiters.shift();
    if (waiter) waiter(ev);
    this.fileClip(ev);
  }
  async fileClip(ev) {
    try {
      let src = ev.sourcePath;
      if (!src || !fs.existsSync(src)) throw new Error(`OBS reported ${src || 'no file'}, but it is not there`);
      // With "Automatically remux to mp4" OBS remuxes MKV replays too; take the .mp4 once it is written.
      if (!/\.(mp4|mov)$/i.test(src)) {
        await sleep(1500);
        const sibling = this.files.remuxedSibling(src);
        if (sibling) { await this.files.waitForStableFile(sibling, 5 * 60 * 1000); src = sibling; }
      }
      const dir = path.join(this.files.targetDirFor(src), 'Replays');
      await fsp.mkdir(dir, { recursive: true });
      const target = this.files.uniquePath(dir, ev.base, path.extname(src));
      await moveWithRetry(src, target);
      Object.assign(ev, { path: target, filename: path.basename(target), status: 'saved', error: '' });
      this.log(`Instant replay saved: ${ev.filename}`);
    } catch (e) {
      if (ev.sourcePath && fs.existsSync(ev.sourcePath)) {
        Object.assign(ev, { path: ev.sourcePath, filename: path.basename(ev.sourcePath), status: 'saved', error: `Left where OBS saved it: ${e.message}` });
      } else {
        Object.assign(ev, { status: 'error', error: e.message });
      }
      this.log(`Instant replay: could not file the clip (${e.message})`);
    }
    this.changed();
  }
  replayDir() {
    const rec = this.recordDirectory();
    return rec ? path.join(this.files.targetDirFor(path.join(rec, 'clip')), 'Replays') : '';
  }

  // ---------- vMix ----------
  async syncVmix() {
    const vm = this.vmix;
    if (vm.status !== 'connected') return;
    const rep = vm.replay || {};
    if (!rep.input) {
      this.available = false;
      this.active = false;
      const edition = String(vm.edition || '').trim();
      this.reason = /^(basic|basic hd|sd|hd)$/i.test(edition)
        ? `Instant replay needs vMix 4K, Pro or MAX. This is vMix ${edition}.`
        : 'Add a Replay input in vMix (Add Input, Replay) and set its camera to Output.';
      this.changed();
      return;
    }
    this.available = true;
    this.reason = '';
    this.active = !!rep.recording;
    if (this.wanted() && !rep.recording && !this.vmixStartTried) {
      // Started once per connection, so an operator who stops it in vMix is not overruled.
      this.vmixStartTried = true;
      try {
        await vm.call('ReplayStartRecording');
        this.active = true;
        this.startedByUs = true;
        this.log('Instant replay: vMix replay recording started');
      } catch (e) { this.lastError = e.message; }
    } else if (!this.wanted() && rep.recording && this.startedByUs) {
      // Record mode: stop the replay recording the recorder started (it writes to disk the whole time).
      try {
        await vm.call('ReplayStopRecording');
        this.active = false;
        this.log('Instant replay: vMix replay recording stopped (Record mode)');
      } catch (e) { this.lastError = e.message; }
      this.startedByUs = false;
    }
    this.changed();
  }
  async saveVmix() {
    const vm = this.vmix;
    if (vm.status !== 'connected') throw new Error('vMix is not connected');
    await vm.refresh().catch(() => {});
    await this.syncVmix();
    if (!this.available) throw new Error(this.reason);
    if (!this.active) throw new Error('vMix replay is not recording. Press Record on the Replay input in vMix');
    const meta = this.metaNow();
    await vm.call('ReplayMarkInOutLive', { Value: this.conf().seconds });
    for (const e of this.events) e.vmixLast = false;
    const ev = this.addEvent(meta, { status: 'saved', vmixLast: true, vmixOnly: true });
    if (vm.canSnapshot()) this.exportVmix(ev);
    else { ev.error = 'Kept in vMix only: vMix runs on another PC, so the recorder cannot collect the file'; this.changed(); }
    return ev;
  }
  // vMix sends no "done" for an export: watch the folder for a new video that stops growing.
  async exportVmix(ev) {
    const dir = this.replayDir();
    if (!dir) { ev.error = 'Kept in vMix only: the recordings folder is not known yet (Settings, vMix)'; this.changed(); return; }
    ev.exporting = true;
    this.changed();
    try {
      await fsp.mkdir(dir, { recursive: true });
      const before = new Set(await fsp.readdir(dir));
      await this.vmix.call('ReplayExportLastEvent', { Value: dir });
      const end = Date.now() + 120000;
      let file = '';
      while (!file && Date.now() < end) {
        await sleep(1000);
        const name = (await fsp.readdir(dir)).find((n) => !before.has(n) && VIDEO_EXT.test(n));
        if (name) file = path.join(dir, name);
      }
      if (!file) throw new Error('vMix did not export the clip within two minutes');
      await this.files.waitForStableFile(file, 5 * 60 * 1000);
      const target = this.files.uniquePath(dir, ev.base, path.extname(file));
      await moveWithRetry(file, target);
      Object.assign(ev, { path: target, filename: path.basename(target), vmixOnly: false, error: '' });
      this.log(`Instant replay exported from vMix: ${ev.filename}`);
    } catch (e) {
      ev.error = `Kept in vMix only: ${e.message}`;
      this.log(`Instant replay: vMix export failed (${e.message})`);
    } finally {
      ev.exporting = false;
      this.changed();
    }
  }

  // ---------- playback ----------
  find(id) { return this.events.find((e) => e.id === id) || null; }
  async play(id, speed) {
    const sp = clampSpeed(speed ?? this.conf().speed);
    const ev = id ? this.find(id) : this.events.find((e) => e.status === 'saved');
    if (!ev) throw new Error(id ? 'That replay is no longer in the list' : 'No replay saved yet: press REPLAY first');
    if (this.getSw().status !== 'connected') throw new Error(`${this.isObs() ? 'OBS' : 'vMix'} is not connected`);
    this.playlist = null;
    return this.isObs() ? this.playObs(ev, sp) : this.playVmix(ev, sp);
  }
  // The queue on air: each clip at the same speed, back to back in the TEC Replay scene. The first goes
  // where single replays go (Preview or Program); the rest follow on their own as each one ends.
  async playQueue(speed) {
    if (!this.isObs()) throw new Error('The on-air queue plays through OBS. With vMix, play the clips from its Replay input');
    if (this.obs.status !== 'connected') throw new Error('OBS is not connected');
    const items = this.queue.map((id) => this.find(id)).filter((e) => e && e.status === 'saved' && e.path && fs.existsSync(e.path));
    if (!items.length) throw new Error('The queue is empty: add clips with + first');
    this.playlist = { ids: items.map((e) => e.id), index: 0, speed: clampSpeed(speed ?? this.conf().speed) };
    this.log(`Instant replay queue: ${items.length} clip${items.length === 1 ? '' : 's'} at ${this.playlist.speed}%`);
    return this.playObs(items[0], this.playlist.speed);
  }
  queueAction(action, id = '') {
    const has = (x) => this.queue.includes(x);
    switch (action) {
      case 'add':
        if (!this.find(id)) throw new Error('That replay is no longer in the list');
        if (!has(id)) this.queue.push(id);
        break;
      case 'remove':
        this.queue = this.queue.filter((x) => x !== id);
        break;
      case 'up':
      case 'down': {
        const i = this.queue.indexOf(id);
        const j = action === 'up' ? i - 1 : i + 1;
        if (i >= 0 && j >= 0 && j < this.queue.length) [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
        break;
      }
      case 'starred':
        // Oldest first, the order they happened in.
        for (const e of [...this.events].reverse()) if (e.star && e.status === 'saved' && !has(e.id)) this.queue.push(e.id);
        break;
      case 'clear':
        this.queue = [];
        break;
      default:
        throw new Error('Unknown queue action');
    }
    this.changed();
    return this.queue;
  }
  // A title for a clip, shown in the list and the starred export (never on air). The file is renamed to match so the
  // Replays folder reads well, unless OBS has that file open in the replay scene right now.
  async setTitle(id, title) {
    const ev = this.find(id);
    if (!ev) throw new Error('That replay is no longer in the list');
    ev.title = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    ev.renameNote = '';
    if (ev.path && fs.existsSync(ev.path)) {
      const base = this.files.sanitizeFilename(ev.title ? `${ev.date} ${ev.set ? `${ev.set} ` : ''}${ev.title}` : ev.base);
      const ext = path.extname(ev.path);
      if (base && base !== path.basename(ev.path, ext)) {
        if (await this.clipInUse(ev.path)) {
          ev.renameNote = 'File name kept: OBS has this clip open';
        } else {
          try {
            const target = await moveWithRetry(ev.path, this.files.uniquePath(path.dirname(ev.path), base, ext), 3000);
            Object.assign(ev, { path: target, filename: path.basename(target) });
          } catch (e) { ev.renameNote = `File name kept (${e.code || e.message})`; }
        }
      }
    }
    if (this.playing && this.playing.id === id) this.playing.title = ev.title;
    this.changed();
    return ev;
  }
  async clipInUse(file) {
    if (!this.isObs() || this.obs.status !== 'connected') return false;
    try {
      const s = await this.obs.request('GetInputSettings', { inputName: CLIP });
      return path.normalize(String(s.inputSettings.local_file || '')).toLowerCase() === path.normalize(file).toLowerCase();
    } catch { return false; }
  }
  // The starred clips as a playlist (VLC, OBS's VLC source, a video editor's import) and a spreadsheet
  // for the social team, written next to the newest starred clip.
  async exportStarred() {
    const starred = this.events.filter((e) => e.star && e.path && fs.existsSync(e.path)).reverse();
    if (!starred.length) throw new Error('No starred clips yet: tap ☆ on the clips to keep');
    const dir = path.dirname(starred[starred.length - 1].path);
    const base = path.join(dir, `${localDate(new Date())} starred clips`);
    const name = (e) => e.title || (e.p1 || e.p2 ? `${e.p1 || 'Player 1'} vs ${e.p2 || 'Player 2'}` : `Replay ${e.n || ''}`.trim());
    const rel = (p) => (path.dirname(p) === dir ? path.basename(p) : p);
    const m3u = ['#EXTM3U', ...starred.flatMap((e) => [`#EXTINF:-1,${name(e).replace(/[\r\n,]/g, ' ')}`, rel(e.path)])];
    const cell = (v) => { const s = String(v ?? ''); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = [['Time', 'Set', 'Round', 'Player 1', 'Player 2', 'Title', 'File'],
      ...starred.map((e) => [new Date(e.ts).toLocaleTimeString(), e.set, e.round, e.p1, e.p2, e.title || '', e.path])];
    await fsp.writeFile(`${base}.m3u8`, `${m3u.join('\r\n')}\r\n`);
    await fsp.writeFile(`${base}.csv`, `﻿${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`);
    this.log(`Instant replay: exported ${starred.length} starred clip${starred.length === 1 ? '' : 's'} to ${base}.m3u8 and .csv`);
    return { count: starred.length, dir, files: [`${base}.m3u8`, `${base}.csv`] };
  }
  async playObs(ev, sp) {
    if (ev.status === 'saving') throw new Error('That replay is still being saved, one moment');
    if (!ev.path || !fs.existsSync(ev.path)) throw new Error(`The clip file is missing${ev.path ? `: ${ev.path}` : ''}`);
    await this.ensureScene();
    const obs = this.obs;
    await obs.request('SetInputSettings', { inputName: CLIP, inputSettings: clipSettings(ev.path, sp) });
    // Slowed audio plays pitch-shifted and the buffer also holds the casters' mics, so only 100% may be heard.
    await obs.request('SetInputMute', { inputName: CLIP, inputMuted: !(this.conf().audio && sp === 100) }).catch(() => {});
    let program = obs.program;
    try { program = (await obs.request('GetCurrentProgramScene')).currentProgramSceneName; } catch { /* use the tracked one */ }
    if (program !== SCENE) this.returnTo = program;
    // What the operator had cued in Preview, put back once the replay is over.
    if (obs.studioMode && obs.preview && obs.preview !== SCENE) this.cueBefore = obs.preview;
    this.loadedAt = Date.now();
    this.playing = { id: ev.id, speed: sp, at: new Date().toISOString(), title: ev.title || '' };
    this.changed();
    // OBS opens a new file in a Media Source that is not live only when told to play, so without this
    // Preview would show the last frame of the previous replay. Taken live, it starts again from the top.
    await obs.request('TriggerMediaInputAction', { inputName: CLIP, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' }).catch(() => {});
    if (program === SCENE) {
      this.log(`Instant replay: playing ${ev.filename} at ${sp}% (already on air)`);
      return { playing: this.playing, to: 'program' };
    }
    await this.sendScene(SCENE);
    this.log(`Instant replay: ${ev.filename} at ${sp}%`);
    return { playing: this.playing, to: this.scenesTo() };
  }
  async playVmix(ev, sp) {
    if (!ev.vmixLast) throw new Error('From here vMix can only play its newest replay event. Play older ones from the Replay input in vMix');
    await this.vmix.call('ReplaySetSpeed', { Value: (sp / 100).toFixed(2) });
    await this.vmix.call('ReplayPlayLastEventToOutput');
    this.playing = { id: ev.id, speed: sp, at: new Date().toISOString() };
    clearTimeout(this.playTimer);
    this.playTimer = setTimeout(() => { this.playing = null; this.changed(); }, ((ev.seconds || 15) * 100 / sp + 2) * 1000);
    this.changed();
    return { playing: this.playing, to: 'program' };
  }
  async onClipEnded() {
    if (!this.playing) return;
    // Ended while waiting in Preview: it starts again from the top when it is taken live.
    if (this.obs.program !== SCENE) return;
    // Loading a new file can report the old one ending; that is not the end of the new clip.
    if (Date.now() - this.loadedAt < 1500) return;
    if (this.playlist) {
      const pl = this.playlist;
      while (pl.index + 1 < pl.ids.length) {
        pl.index += 1;
        const ev = this.find(pl.ids[pl.index]);
        if (!ev || !ev.path || !fs.existsSync(ev.path)) continue;
        try {
          this.loadedAt = Date.now();
          await this.obs.request('SetInputSettings', { inputName: CLIP, inputSettings: clipSettings(ev.path, pl.speed) });
          await this.obs.request('TriggerMediaInputAction', { inputName: CLIP, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART' }).catch(() => {});
          this.playing = { id: ev.id, speed: pl.speed, at: new Date().toISOString(), title: ev.title || '' };
          this.log(`Instant replay queue: ${pl.index + 1} of ${pl.ids.length}, ${ev.filename}`);
          this.changed();
          return;
        } catch (e) { this.log(`Instant replay queue: skipped ${ev.filename} (${e.message})`); }
      }
      this.playlist = null;
    }
    const back = this.returnTo;
    this.playing = null;
    this.changed();
    if (!this.conf().autoReturn || !back) return;
    try {
      await this.obs.setProgramScene(back);
      this.returnTo = '';
      this.log(`Instant replay over: "${back}" is live again`);
      await this.restoreCue(back);
    } catch (e) { this.log(`Instant replay: could not take "${back}" back live (${e.message})`); }
    this.changed();
  }
  // Studio Mode keeps the replay in Preview after it has played, where a stray Transition would run it
  // again: cue what the operator had there before (else the scene that just went back live).
  async restoreCue(back) {
    const obs = this.obs;
    if (!obs.studioMode || obs.preview !== SCENE) return;
    const cue = this.cueBefore && this.cueBefore !== SCENE ? this.cueBefore : back;
    this.cueBefore = '';
    try { await obs.request('SetCurrentPreviewScene', { sceneName: cue }); } catch { /* the scene may be gone */ }
  }
  // "Back to live": the scene that was on air before the replay, straight to Program.
  async back() {
    if (!this.isObs()) throw new Error('Take the next input live in vMix');
    const target = this.returnTo;
    if (!target) throw new Error('No scene to go back to: pick one with the scene buttons');
    this.playlist = null;
    await this.obs.setProgramScene(target);
    this.returnTo = '';
    this.playing = null;
    await this.restoreCue(target);
    this.log(`Instant replay: back to "${target}"`);
    this.changed();
    return target;
  }

  // ---------- the TEC Replay scene in OBS ----------
  async checkScene() {
    try {
      const scenes = (await this.obs.request('GetSceneList')).scenes.map((s) => s.sceneName);
      this.sceneInstalled = scenes.includes(SCENE);
    } catch { /* keep the last known */ }
  }
  async ensureScene() {
    const scenes = (await this.obs.request('GetSceneList')).scenes.map((s) => s.sceneName);
    const inputs = (await this.obs.request('GetInputList')).inputs.map((i) => i.inputName);
    if (!scenes.includes(SCENE) || !inputs.includes(CLIP)) await this.installScene();
  }
  async installScene() {
    const obs = this.obs;
    if (!this.isObs() || obs.status !== 'connected') throw new Error('OBS is not connected');
    let canvas = { w: 1920, h: 1080 };
    try { const v = await obs.request('GetVideoSettings'); canvas = { w: v.baseWidth || 1920, h: v.baseHeight || 1080 }; } catch { /* assume 1080p */ }
    const scenes = (await obs.request('GetSceneList')).scenes.map((s) => s.sceneName);
    if (!scenes.includes(SCENE)) await obs.request('CreateScene', { sceneName: SCENE });
    const inputs = (await obs.request('GetInputList')).inputs.map((i) => i.inputName);
    const items = async () => ((await obs.request('GetSceneItemList', { sceneName: SCENE })).sceneItems || []);
    const ensureItem = async (name, kind, settings) => {
      const have = (await items()).find((i) => i.sourceName === name);
      if (have) { await obs.request('SetInputSettings', { inputName: name, inputSettings: settings }); return have.sceneItemId; }
      if (inputs.includes(name)) {
        await obs.request('SetInputSettings', { inputName: name, inputSettings: settings });
        return (await obs.request('CreateSceneItem', { sceneName: SCENE, sourceName: name, sceneItemEnabled: true })).sceneItemId;
      }
      return (await obs.request('CreateInput', { sceneName: SCENE, inputName: name, inputKind: kind, inputSettings: settings, sceneItemEnabled: true })).sceneItemId;
    };
    const clipId = await ensureItem(CLIP, 'ffmpeg_source', clipSettings('', this.conf().speed));
    // Fit the clip to the canvas, so a clip recorded at a smaller output size still fills the screen.
    await obs.request('SetSceneItemTransform', {
      sceneName: SCENE, sceneItemId: clipId,
      sceneItemTransform: { positionX: 0, positionY: 0, alignment: 5, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 0, boundsWidth: canvas.w, boundsHeight: canvas.h },
    }).catch(() => {});
    const badgeId = await ensureItem(BADGE, 'browser_source', browserSettings(this.badgeUrl()));
    await obs.request('SetSceneItemTransform', {
      sceneName: SCENE, sceneItemId: badgeId,
      sceneItemTransform: { positionX: 0, positionY: 0, alignment: 5, boundsType: 'OBS_BOUNDS_NONE', scaleX: canvas.w / 1920, scaleY: canvas.h / 1080 },
    }).catch(() => {});
    const list = await items();
    const top = list.find((i) => i.sourceName === BADGE);
    if (top) await obs.request('SetSceneItemIndex', { sceneName: SCENE, sceneItemId: top.sceneItemId, sceneItemIndex: Math.max(0, list.length - 1) }).catch(() => {});
    await obs.request('SetInputMute', { inputName: CLIP, inputMuted: true }).catch(() => {});
    await this.syncFade();
    this.sceneInstalled = true;
    this.log(`Instant replay: scene "${SCENE}" ready in OBS (clip "${CLIP}", badge "${BADGE}")`);
    this.changed();
    return { ok: true, scene: SCENE };
  }
  badgeUrl() { return `http://localhost:${this.getCfg().port || 8420}/replay`; }

  // ---------- list upkeep ----------
  setSpeed(n) {
    this.getCfg().replay.speed = clampSpeed(n);
    this.saveConfig();
    this.changed();
    return this.getCfg().replay.speed;
  }
  star(id) {
    const e = this.find(id);
    if (!e) throw new Error('That replay is no longer in the list');
    e.star = !e.star;
    this.changed();
    return e.star;
  }
  remove(id) {
    const before = this.events.length;
    this.events = this.events.filter((e) => e.id !== id);
    this.queue = this.queue.filter((x) => x !== id);
    this.changed();
    return this.events.length !== before;
  }
  clipPath(id) {
    const e = this.find(id);
    return e && e.path && fs.existsSync(e.path) ? e.path : '';
  }
}

module.exports = { Replay, SCENE: SCENE, CLIP, BADGE, clampSpeed };
