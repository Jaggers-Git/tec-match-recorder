'use strict';
// Training and review: scan old recordings for VS screens (OBS plays the file through a
// temporary media source), keep a review queue, and turn confirmed items into templates.
const fs = require('node:fs');
const path = require('node:path');
const png = require('./png');
const im = require('./image');
const { GEOMETRY } = require('./detector');

const SCENE = 'TEC Trainer (temp)';
const INPUT = 'TEC Trainer Media (temp)';
const VIDEO_EXT = new Set(['.mp4', '.mkv', '.mov', '.flv', '.ts', '.m4v', '.webm']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Trainer {
  constructor({ dataDir, obs, detector, getCfg, log, onChange }) {
    this.dir = path.join(dataDir, 'train');
    fs.mkdirSync(this.dir, { recursive: true });
    this.queueFile = path.join(this.dir, 'queue.json');
    this.samplesDir = detector.samplesDir;
    this.obs = obs;
    this.detector = detector;
    this.getCfg = getCfg;
    this.log = log;
    this.onChange = onChange;
    this.queue = [];
    try { this.queue = JSON.parse(fs.readFileSync(this.queueFile, 'utf8')); } catch { this.queue = []; }
    this.scan = { running: false, video: '', tMs: 0, durationMs: 0, found: 0, frames: 0, error: '', cancel: false, startedAt: null, finishedAt: null };
  }
  isScanning() { return this.scan.running; }
  saveQueue() {
    fs.writeFileSync(this.queueFile, JSON.stringify(this.queue, null, 2));
  }
  status() {
    const { cancel, ...scan } = this.scan;
    return { ...scan, pending: this.queue.filter((q) => q.status === 'pending').length, total: this.queue.length };
  }
  listVideos() {
    const folder = this.getCfg().detect.videosFolder;
    if (!folder || !fs.existsSync(folder)) return { folder, videos: [] };
    const videos = fs.readdirSync(folder)
      .filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()))
      .map((f) => { const st = fs.statSync(path.join(folder, f)); return { name: f, path: path.join(folder, f), bytes: st.size, mtime: st.mtime.toISOString() }; })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
    return { folder, videos };
  }
  enqueue(item) {
    this.queue.unshift({ status: 'pending', ...item });
    if (this.queue.length > 2000) this.queue.length = 2000;
    this.saveQueue();
    this.onChange();
  }
  pending(limit = 50) {
    return this.queue.filter((q) => q.status === 'pending').slice(0, limit);
  }
  removeFiles(item) {
    const files = [item.frameFile, item.p1 && item.p1.maskFile, item.p1 && item.p1.cropFile, item.p1 && item.p1.hudCropFile, item.p2 && item.p2.maskFile, item.p2 && item.p2.cropFile, item.p2 && item.p2.hudCropFile].filter(Boolean);
    for (const f of files) { try { fs.unlinkSync(path.join(this.samplesDir, f)); } catch { /* gone */ } }
  }
  confirm(id, { isVs = true, p1 = '', p2 = '' } = {}) {
    const item = this.queue.find((q) => q.id === id);
    if (!item) throw new Error('Review item not found');
    if (isVs === false) {
      item.status = 'rejected';
      item.reviewedAt = new Date().toISOString();
      this.removeFiles(item);
      this.saveQueue();
      this.onChange();
      return item;
    }
    const learned = [];
    for (const side of [1, 2]) {
      const name = String((side === 1 ? p1 : p2) || '').trim();
      const info = item[`p${side}`];
      if (!name || !info) continue;
      if (info.maskFile) {
        let mask = null;
        try { mask = im.imageToMask(png.decode(fs.readFileSync(path.join(this.samplesDir, info.maskFile)))); } catch { mask = null; }
        if (mask) {
          let cropImg = null;
          if (info.cropFile) { try { cropImg = png.decode(fs.readFileSync(path.join(this.samplesDir, info.cropFile))); } catch { cropImg = null; } }
          this.detector.store.add(name, mask, cropImg, { source: item.source || 'review', video: item.video || '', tMs: item.tMs || null });
          learned.push(`${name} (VS text)`);
        }
      }
      if (info.hudCropFile) {
        try {
          this.detector.icons.addLearned(name, png.decode(fs.readFileSync(path.join(this.samplesDir, info.hudCropFile))));
          learned.push(`${name} (HUD portrait)`);
        } catch { /* unreadable crop */ }
      }
      info.confirmed = name;
    }
    if (item.frameFile && ((!this.detector.store.anchor && item.kind !== 'hud') || (!this.detector.store.hudAnchors && item.kind === 'hud'))) {
      try {
        const frame = png.decode(fs.readFileSync(path.join(this.samplesDir, item.frameFile)));
        if (item.kind === 'hud') {
          this.detector.store.setHudAnchors(frame);
          this.log('HUD "%" anchors learned from a confirmed frame');
        } else {
          this.detector.store.setAnchor(this.detector.anchorCrop(frame));
          this.log('VS-screen anchor learned from a confirmed frame');
        }
      } catch { /* keep going without anchor */ }
    }
    item.status = 'confirmed';
    item.reviewedAt = new Date().toISOString();
    item.learned = learned;
    this.removeFiles(item);
    this.saveQueue();
    this.onChange();
    return item;
  }
  skip(id) {
    const item = this.queue.find((q) => q.id === id);
    if (!item) throw new Error('Review item not found');
    item.status = 'skipped';
    item.reviewedAt = new Date().toISOString();
    this.removeFiles(item);
    this.saveQueue();
    this.onChange();
    return item;
  }
  clearReviewed() {
    this.queue = this.queue.filter((q) => q.status === 'pending');
    this.saveQueue();
    this.onChange();
  }
  cancelScan() { if (this.scan.running) this.scan.cancel = true; }

  // If the app died mid-scan, OBS is left showing the temporary scene. Put it back on connect.
  async cleanupLeftovers() {
    if (this.scan.running) return;
    try {
      const scenes = (await this.obs.request('GetSceneList')).scenes.map((s) => s.sceneName);
      if (!scenes.includes(SCENE)) return;
      const current = (await this.obs.request('GetCurrentProgramScene')).currentProgramSceneName;
      if (current === SCENE) {
        const other = scenes.find((s) => s !== SCENE);
        if (other) await this.obs.request('SetCurrentProgramScene', { sceneName: other });
      }
      try { await this.obs.request('RemoveInput', { inputName: INPUT }); } catch { /* not there */ }
      await this.obs.request('RemoveScene', { sceneName: SCENE });
      this.log('Removed a leftover trainer scene from OBS');
    } catch { /* best effort */ }
  }

  async startScan(videoPath, { strideMs = 2500, startSec = 0, lanes = 4 } = {}) {
    if (this.scan.running) throw new Error('A scan is already running');
    if (!fs.existsSync(videoPath)) throw new Error('Video file not found');
    if (this.getCfg().switcher === 'vmix') throw new Error('Training scans play old recordings through OBS. Switch Settings, Production software, to OBS for the scan, then back to vMix.');
    if (this.obs.status !== 'connected') throw new Error('OBS is not connected');
    const rec = await this.obs.request('GetRecordStatus');
    if (rec.outputActive) throw new Error('OBS is recording; scanning would take over the program scene');
    try {
      const stream = await this.obs.request('GetStreamStatus');
      if (stream.outputActive) throw new Error('OBS is streaming; scanning would take over the program scene');
    } catch (e) { if (/streaming/.test(e.message)) throw e; }
    const laneCount = Math.min(8, Math.max(1, Math.round(Number(lanes) || 1)));
    this.scan = { running: true, video: path.basename(videoPath), lanes: laneCount, tMs: 0, durationMs: 0, found: 0, frames: 0, error: '', cancel: false, startedAt: new Date().toISOString(), finishedAt: null };
    this.onChange();
    this.runScan(videoPath, Math.max(500, strideMs), Math.max(0, startSec) * 1000, laneCount).catch((e) => {
      this.scan.error = e.message;
      this.log(`Scan failed: ${e.message}`);
    }).finally(() => {
      this.scan.running = false;
      this.scan.finishedAt = new Date().toISOString();
      this.onChange();
    });
  }
  // OBS caps a media source at 200% speed and seeking only lands on keyframes, so the recording is
  // split into lanes: several media sources in the temporary scene, each playing its own slice at 2x,
  // sampled round-robin. Four lanes cover an hour of footage in roughly eight minutes.
  async runScan(videoPath, strideMs, startMs, laneCount) {
    let originalScene = null;
    const laneName = (i) => `${INPUT} ${i + 1}`;
    const settings = { local_file: videoPath, is_local_file: true, looping: false, restart_on_activate: false, close_when_inactive: false, hw_decode: true, clear_on_media_end: false, speed_percent: 200 };
    const cleanup = async () => {
      try { if (originalScene) await this.obs.request('SetCurrentProgramScene', { sceneName: originalScene }); } catch { /* ignore */ }
      for (let i = 0; i < 8; i += 1) { try { await this.obs.request('RemoveInput', { inputName: laneName(i) }); } catch { /* not there */ } }
      try { await this.obs.request('RemoveInput', { inputName: INPUT }); } catch { /* not there */ }
      try { await this.obs.request('RemoveScene', { sceneName: SCENE }); } catch { /* ignore */ }
    };
    const status = (name) => this.obs.request('GetMediaInputStatus', { inputName: name });
    try {
      originalScene = (await this.obs.request('GetCurrentProgramScene')).currentProgramSceneName;
      try { await this.obs.request('CreateScene', { sceneName: SCENE }); } catch { /* exists */ }
      for (let i = 0; i < 8; i += 1) { try { await this.obs.request('RemoveInput', { inputName: laneName(i) }); } catch { /* not there */ } }
      await sleep(300);
      await this.obs.request('CreateInput', { sceneName: SCENE, inputName: laneName(0), inputKind: 'ffmpeg_source', sceneItemEnabled: true, inputSettings: settings });
      await this.obs.request('SetCurrentProgramScene', { sceneName: SCENE });
      let duration = 0;
      for (let i = 0; i < 40 && !duration; i += 1) {
        await sleep(200);
        try { duration = (await status(laneName(0))).mediaDuration || 0; } catch { duration = 0; }
      }
      if (!duration) throw new Error('OBS could not open the video');
      this.scan.durationMs = duration;
      const span = Math.max(1000, (duration - startMs) / laneCount);
      const lanes = [];
      for (let i = 0; i < laneCount; i += 1) {
        const name = laneName(i);
        if (i > 0) await this.obs.request('CreateInput', { sceneName: SCENE, inputName: name, inputKind: 'ffmpeg_source', sceneItemEnabled: true, inputSettings: settings });
        const start = Math.round(startMs + i * span);
        const end = i === laneCount - 1 ? duration : Math.round(startMs + (i + 1) * span);
        lanes.push({ name, start, end, cursor: start, done: false, lastVsMs: -1e9, lastHudMs: -1e9, lastSide: { 1: '', 2: '' }, stalled: 0, lastCursor: -1 });
      }
      for (let i = 0; i < 40; i += 1) {
        await sleep(200);
        let ready = true;
        for (const lane of lanes) { try { if ((await status(lane.name)).mediaState !== 'OBS_MEDIA_STATE_PLAYING') ready = false; } catch { ready = false; } }
        if (ready) break;
      }
      for (const lane of lanes) {
        if (lane.start > 0) await this.obs.request('SetMediaInputCursor', { inputName: lane.name, mediaCursor: lane.start });
      }
      await sleep(600);
      const iterTarget = Math.max(250, strideMs / 2);
      let lastBroadcast = 0;
      while (!this.scan.cancel && lanes.some((l) => !l.done)) {
        const t0 = Date.now();
        for (const lane of lanes) {
          if (lane.done || this.scan.cancel) continue;
          const st = await status(lane.name);
          const cursor = st.mediaCursor || 0;
          if (st.mediaState === 'OBS_MEDIA_STATE_ENDED' || st.mediaState === 'OBS_MEDIA_STATE_STOPPED' || st.mediaState === 'OBS_MEDIA_STATE_ERROR' || cursor >= lane.end - 300) { lane.done = true; continue; }
          if (cursor === lane.lastCursor) { lane.stalled += 1; if (lane.stalled > 60) { lane.done = true; this.log(`${lane.name} stalled, giving up on that slice`); continue; } } else lane.stalled = 0;
          lane.lastCursor = cursor;
          lane.cursor = cursor;
          const frame = await this.detector.grab(lane.name);
          this.scan.frames += 1;
          const res = this.detector.analyze(frame);
          const hud = this.detector.icons.size ? this.detector.analyzeHud(frame) : null;
          let hudWorthIt = false;
          if (hud) {
            for (const side of [1, 2]) {
              if (hud[side].confident && hud[side].character !== lane.lastSide[side]) { lane.lastSide[side] = hud[side].character; hudWorthIt = true; }
            }
            hudWorthIt = hudWorthIt && cursor - lane.lastHudMs > 10000;
          }
          const meta = { source: 'scan', video: path.basename(videoPath), tMs: cursor };
          if (res.isVs && cursor - lane.lastVsMs > 6000) {
            lane.lastVsMs = cursor;
            this.scan.found += 1;
            this.enqueue(this.detector.makeReviewItem(frame, res, meta, hudWorthIt ? hud : null));
            if (hudWorthIt) lane.lastHudMs = cursor;
          } else if (hudWorthIt) {
            lane.lastHudMs = cursor;
            this.scan.found += 1;
            this.enqueue(this.detector.makeReviewItem(frame, null, meta, hud));
          }
        }
        this.scan.tMs = startMs + lanes.reduce((s, l) => s + Math.max(0, Math.min(l.cursor, l.end) - l.start), 0);
        if (Date.now() - lastBroadcast > 1000) { lastBroadcast = Date.now(); this.onChange(); }
        const spent = Date.now() - t0;
        if (spent < iterTarget) await sleep(iterTarget - spent);
      }
      this.log(`Scan of ${path.basename(videoPath)} finished: ${this.scan.frames} frames over ${laneCount} lane(s), ${this.scan.found} items`);
    } finally {
      await cleanup();
    }
  }
}
module.exports = { Trainer, SCENE, INPUT };
