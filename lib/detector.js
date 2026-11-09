'use strict';
// Character detection from the Smash Ultimate VS splash screen ("P1 FOX vs P2 STEVE").
// Frames come from OBS (GetSourceScreenshot) at 960x540, or from a vMix snapshot resized to that;
// the fighter names are read by
// matching the white name text against templates learned from confirmed detections.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const png = require('./png');
const im = require('./image');
const { IconPack } = require('./icons');
const { StageReader, fingerprint } = require('./stages');

// A game's stage is decided once this many in-game frames agree; a game ends after this long without
// the in-game display (results, character select, the VS screen).
const STAGE_MIN_FRAMES = 3;
const STAGE_GAME_GAP_MS = 20000;
// A frame only votes when some reference is this close. On the test VODs a frame of a known stage sat
// within 0.16 of its references (0.46 for the worst 5%), and a stage with no references never came
// closer than 0.49, so a stage the reader does not know stays blank instead of taking a lookalike's name.
const STAGE_MAX_DISTANCE = 0.45;
// Battlefield and Small Battlefield share a backdrop and differ only by Battlefield's top platform, which the
// fingerprint cannot see reliably, so a read of either is reported as unsure for the operator to check.
const SHARED_BACKDROP = new Set(['Battlefield', 'Small Battlefield']);

// Geometry at 960x540 (half of the Switch's 1080p output).
const GEOMETRY = {
  width: 960,
  height: 540,
  vsAnchor: { x: 445, y: 218, w: 150, h: 92 },
  names: {
    1: { x: 40, y: 0, w: 440, h: 80 },
    2: { x: 560, y: 15, w: 395, h: 110 },
  },
  letterHeight: [20, 100],
  minLetterPixels: 15,
  whiteMin: 200,
  maxChroma: 24,
  normW: 128,
  normH: 48,
  // In-game HUD portraits (stock-icon artwork) for a 1v1, at 960x540.
  hud: {
    1: { x: 195, y: 447, w: 70, h: 70 },
    2: { x: 570, y: 447, w: 70, h: 70 },
  },
  // The damage "%" glyph: right-aligned, so it stays put whatever the number says. Used to prove a HUD is on screen.
  hudPercent: {
    1: { x: 334, y: 480, w: 16, h: 15 },
    2: { x: 708, y: 480, w: 16, h: 15 },
  },
  hudPresenceMin: 0.6,
  hudPresenceSearch: 6,
};

// With a side's character locked, the full portrait search still runs on every this-many frames.
const FULL_EVERY = 5;
// While a game is on screen and both characters are locked, look this often instead of every second.
// The in-game display vanishing (game over) brings the normal rate back, in time for the next VS screen
// and the next game's opening seconds.
const LOCKED_INTERVAL_MS = 2500;

function anchorFeatures(img) {
  return { lum: im.luminance(img), mask: im.whiteMask(img, GEOMETRY.whiteMin, GEOMETRY.maxChroma) };
}

class TemplateStore {
  constructor(dir) {
    this.dir = dir;
    this.indexFile = path.join(dir, 'index.json');
    this.items = [];
    this.anchor = null;
    this.load();
  }
  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    let index = [];
    try { index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); } catch { index = []; }
    this.items = [];
    for (const entry of index) {
      try {
        const img = png.decode(fs.readFileSync(path.join(this.dir, entry.file)));
        this.items.push({ ...entry, mask: im.imageToMask(img) });
      } catch { /* skip unreadable template */ }
    }
    const anchorFile = path.join(this.dir, 'anchor-vs.png');
    if (fs.existsSync(anchorFile)) {
      try { this.anchor = anchorFeatures(png.decode(fs.readFileSync(anchorFile))); } catch { this.anchor = null; }
    }
    this.hudAnchors = null;
    const h1 = path.join(this.dir, 'anchor-hud-p1.png');
    const h2 = path.join(this.dir, 'anchor-hud-p2.png');
    if (fs.existsSync(h1) && fs.existsSync(h2)) {
      try { this.hudAnchors = { 1: im.luminance(png.decode(fs.readFileSync(h1))), 2: im.luminance(png.decode(fs.readFileSync(h2))) }; } catch { this.hudAnchors = null; }
    }
  }
  // The "%" glyph is identical on both panels but its color follows the damage (white at low damage,
  // dark red at high), so learn from whichever side has more contrast and use it for both.
  setHudAnchors(frame) {
    const crops = [1, 2].map((side) => {
      const b = GEOMETRY.hudPercent[side];
      const crop = im.crop(frame, b.x, b.y, b.w, b.h);
      const lum = im.luminance(crop);
      const mean = lum.reduce((s, v) => s + v, 0) / lum.length;
      const sd = Math.sqrt(lum.reduce((s, v) => s + (v - mean) ** 2, 0) / lum.length);
      return { crop, lum, sd };
    });
    const best = crops[0].sd >= crops[1].sd ? crops[0] : crops[1];
    for (const side of [1, 2]) fs.writeFileSync(path.join(this.dir, `anchor-hud-p${side}.png`), png.encode(best.crop));
    this.hudAnchors = { 1: best.lum, 2: best.lum };
  }
  saveIndex() {
    fs.writeFileSync(this.indexFile, JSON.stringify(this.items.map(({ mask, ...rest }) => rest), null, 2));
  }
  add(character, normMask, cropImg, meta = {}) {
    const id = crypto.randomUUID().slice(0, 8);
    const safe = character.replace(/[^\w.& -]/g, '').trim() || 'unknown';
    const file = `${safe} ${id}.png`;
    fs.writeFileSync(path.join(this.dir, file), png.encode(im.maskToImage(normMask, GEOMETRY.normW, GEOMETRY.normH)));
    if (cropImg && cropImg.width && cropImg.height) fs.writeFileSync(path.join(this.dir, `${safe} ${id} crop.png`), png.encode(cropImg));
    const entry = { id, character, file, addedAt: new Date().toISOString(), ...meta };
    this.items.push({ ...entry, mask: normMask });
    this.saveIndex();
    return entry;
  }
  remove(id) {
    const entry = this.items.find((t) => t.id === id);
    if (!entry) return false;
    this.items = this.items.filter((t) => t.id !== id);
    for (const f of [entry.file, entry.file.replace(/\.png$/, ' crop.png')]) {
      try { fs.unlinkSync(path.join(this.dir, f)); } catch { /* already gone */ }
    }
    this.saveIndex();
    return true;
  }
  setAnchor(img) {
    fs.writeFileSync(path.join(this.dir, 'anchor-vs.png'), png.encode(img));
    this.anchor = anchorFeatures(img);
  }
  summary() {
    const out = {};
    for (const t of this.items) out[t.character] = (out[t.character] || 0) + 1;
    return out;
  }
}

class Detector {
  // screenshot(sourceName, width, height) resolves to PNG bytes from whichever app is recording.
  // knownCharacters(side) lists the characters already on the current set for that side (from the VS
  // screen, earlier games or the operator); the HUD check tries those before the whole pack.
  // onStage({ gameId, stage, done }) reports the stage of the game on screen, and once more when it ends.
  constructor({ dataDir, screenshot, getCfg, shouldRun, getSource, onDetection, onReview, log, rosterNames, knownCharacters, onStage }) {
    this.knownCharacters = knownCharacters || (() => []);
    this.onStage = onStage || (() => {});
    this.stages = new StageReader({ ownFile: path.join(dataDir, 'stages-own.json') });
    this.stageGame = null;
    this.stageFps = new Map(); // gameId -> fingerprints of that game, for learning from a correction
    this.store = new TemplateStore(path.join(dataDir, 'templates'));
    this.samplesDir = path.join(dataDir, 'samples');
    fs.mkdirSync(this.samplesDir, { recursive: true });
    this.icons = new IconPack(path.join(dataDir, 'portraits'), rosterNames || [], 'chara_0');
    this.hud = { votes: { 1: [], 2: [] }, locked: { 1: '', 2: '' }, sinceFull: { 1: 0, 2: 0 }, last: null, lastReviewAt: { 1: 0, 2: 0 } };
    this.screenshot = screenshot;
    this.getCfg = getCfg;
    this.shouldRun = shouldRun;
    this.getSource = getSource;
    this.onDetection = onDetection;
    this.onReview = onReview;
    this.log = log;
    this.timer = null;
    this.busy = false;
    this.state = { running: false, lastFrameAt: null, lastVsAt: null, lastResult: null, lastScore: 0, error: '', frames: 0, cooldownUntil: 0 };
  }
  start() {
    clearInterval(this.timer);
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, 250);
  }
  status() {
    const s = this.state;
    return {
      running: s.running, lastFrameAt: s.lastFrameAt, lastVsAt: s.lastVsAt, lastResult: s.lastResult,
      lastScore: Number(s.lastScore.toFixed(3)), error: s.error, frames: s.frames,
      templates: this.store.items.length, characters: Object.keys(this.store.summary()).length, hasAnchor: !!this.store.anchor, hasHudAnchors: !!this.store.hudAnchors,
      icons: this.icons.summary(), hud: this.hud.last, locked: this.hud.locked,
    };
  }
  async tick() {
    if (this.busy) return;
    const cfg = this.getCfg();
    let interval = Math.max(300, Number(cfg.detect.intervalMs) || 1000);
    const h = this.hud;
    if (h.locked[1] && h.locked[2] && h.onScreen) interval = Math.max(interval, LOCKED_INTERVAL_MS);
    if (this.state.lastFrameAt && Date.now() - this.state.lastFrameAt < interval) return;
    if (!this.shouldRun()) { this.state.running = false; return; }
    this.busy = true;
    this.state.running = true;
    try {
      // '' is vMix's program output; OBS always names a scene or source.
      const source = await this.getSource();
      if (source == null) throw new Error('No detection source selected');
      const frame = await this.grab(source);
      this.state.lastFrameAt = Date.now();
      this.state.frames += 1;
      this.state.error = '';
      if (Date.now() >= this.state.cooldownUntil) {
        const res = this.analyze(frame);
        this.state.lastScore = res.anchorScore;
        if (res.isVs) {
          this.state.lastVsAt = Date.now();
          this.state.cooldownUntil = Date.now() + 12000;
          this.state.lastResult = { p1: res.p1.character || '?', p2: res.p2.character || '?', score: res.anchorScore, at: new Date().toISOString() };
          this.log(`VS screen seen: P1 ${res.p1.character || 'unknown'} (${res.p1.score.toFixed(2)}), P2 ${res.p2.character || 'unknown'} (${res.p2.score.toFixed(2)})`);
          for (const side of [1, 2]) {
            const r = res[`p${side}`];
            if (r.character && r.confident) this.onDetection({ side, character: r.character, score: r.score, kind: 'vs' });
          }
          if (!res.p1.confident || !res.p2.confident) this.onReview(this.makeReviewItem(frame, res, { source: 'live' }));
          this.hud.locked = { 1: '', 2: '' };
        }
      }
      // In a game: the portraits say so when the art pack is here; without it, the learned "%" anchors do.
      const inGame = this.icons.size ? this.trackHud(frame) : this.hudOnScreen(frame);
      if (this.getCfg().detect.stages !== false) this.trackStage(frame, inGame);
    } catch (e) {
      this.state.error = e.message;
    } finally {
      this.busy = false;
    }
  }
  // Re-read the portrait pack after a download from Settings.
  reloadArt() { this.icons.load(); return this.icons.size; }
  resetLocks() {
    this.hud.locked = { 1: '', 2: '' };
    this.hud.votes = { 1: [], 2: [] };
    this.hud.sinceFull = { 1: 0, 2: 0 };
    // A new set starts a new stage vote too (the game in progress belongs to the set it started on).
    this.stageGame = null;
  }
  // How strongly each panel's "%" glyph is visible (normalized correlation, best over a small offset search).
  hudPresence(f) {
    const out = { 1: 0, 2: 0 };
    if (!this.store.hudAnchors) return out;
    const s = GEOMETRY.hudPresenceSearch;
    for (const side of [1, 2]) {
      const b = GEOMETRY.hudPercent[side];
      const anchor = this.store.hudAnchors[side];
      let best = -1;
      for (let dy = -s; dy <= s; dy += 2) {
        for (let dx = -s; dx <= s; dx += 2) {
          const crop = im.crop(f, b.x + dx, b.y + dy, b.w, b.h);
          if (crop.width !== b.w || crop.height !== b.h) continue;
          const v = im.ncc(anchor, im.luminance(crop));
          if (v > best) best = v;
        }
      }
      out[side] = best;
    }
    return out;
  }
  // `useLocks` (live tracking only, never training scans): a side whose character is locked is checked
  // against that character's sprites alone, which takes about 1 ms where the full search scores every
  // sprite in the pack. The full search still runs when that check fails (a counterpick) and every
  // FULL_EVERY frames regardless, so a change is caught even when no VS screen reset the locks.
  analyzeHud(frame, { useLocks = false } = {}) {
    const f = frame.width === GEOMETRY.width && frame.height === GEOMETRY.height ? frame : im.resize(frame, GEOMETRY.width, GEOMETRY.height);
    const presence = this.hudPresence(f);
    const gated = !!this.store.hudAnchors;
    const out = { frame: f, presence, gated };
    for (const side of [1, 2]) {
      const present = !gated || presence[side] >= GEOMETRY.hudPresenceMin;
      if (!present) {
        out[side] = { character: '', costume: -1, score: 0, second: 0, confident: false, alternatives: [], present: false, presence: presence[side] };
        continue;
      }
      const locked = useLocks ? this.hud.locked[side] : '';
      let r = null;
      if (locked && this.hud.sinceFull[side] < FULL_EVERY) {
        r = this.icons.match(f, GEOMETRY.hud[side], { only: locked });
        if (r.confident) this.hud.sinceFull[side] += 1;
        else r = null;
      } else if (useLocks && !locked) {
        // Not locked yet: the characters already on the set (a second game, or tags from the VS screen)
        // are the likeliest, and each takes a fraction of the full search.
        for (const name of this.knownCharacters(side) || []) {
          const k = this.icons.match(f, GEOMETRY.hud[side], { only: name });
          if (k.confident) { r = k; break; }
        }
      }
      if (!r) {
        r = this.icons.match(f, GEOMETRY.hud[side]);
        this.hud.sinceFull[side] = 0;
      }
      out[side] = { ...r, present: true, presence: presence[side] };
    }
    return out;
  }
  // Vote over the last three frames so a single odd frame never tags a set; lock per game so the
  // same character is not re-added every second.
  trackHud(frame) {
    const hud = this.analyzeHud(frame, { useLocks: true });
    const brief = (r) => ({ character: r.character, costume: r.costume, score: Number(r.score.toFixed(3)) });
    this.hud.last = { 1: brief(hud[1]), 2: brief(hud[2]), at: new Date().toISOString() };
    // Only meaningful with the "%" anchors learned (otherwise every frame counts as in-game).
    this.hud.onScreen = hud.gated && hud[1].present && hud[2].present;
    let review = false;
    for (const side of [1, 2]) {
      const r = hud[side];
      const votes = this.hud.votes[side];
      votes.push({ character: r.character, score: r.score, costume: r.costume, confident: r.confident });
      if (votes.length > 5) votes.shift();
      const recent = votes.slice(-3);
      if (recent.length < 3) continue;
      const agree = recent[0].character && recent.every((v) => v.character === recent[0].character);
      const minScore = Math.min(...recent.map((v) => v.score));
      if (agree && recent.every((v) => v.confident)) {
        if (this.hud.locked[side] !== r.character) {
          this.hud.locked[side] = r.character;
          this.onDetection({ side, character: r.character, score: minScore, costume: r.costume, kind: 'hud' });
        }
      } else if (agree && minScore >= 0.45 && Date.now() - this.hud.lastReviewAt[side] > 120000) {
        this.hud.lastReviewAt[side] = Date.now();
        review = true;
      }
    }
    // One review item per frame, covering both sides, rather than one per side with the same frame.
    if (review) this.onReview(this.makeReviewItem(frame, null, { source: 'live' }, hud));
    // In a game: the "%" anchors say so when learned; otherwise both portraits being recognized does.
    return hud.gated ? this.hud.onScreen : !!(hud[1].confident && hud[2].confident);
  }
  // Both damage panels visible, from the "%" anchors alone (no portrait pack needed). False without anchors.
  hudOnScreen(frame) {
    if (!this.store.hudAnchors) return false;
    const f = frame.width === GEOMETRY.width ? frame : im.resize(frame, GEOMETRY.width, GEOMETRY.height);
    const p = this.hudPresence(f);
    return p[1] >= GEOMETRY.hudPresenceMin && p[2] >= GEOMETRY.hudPresenceMin;
  }
  // Stage of the game on screen: each in-game frame votes, and the stage is reported once enough agree.
  trackStage(frame, inGame) {
    const now = Date.now();
    const g = this.stageGame;
    if (g && now - g.lastSeenAt > STAGE_GAME_GAP_MS) this.finishStageGame();
    if (!inGame || !this.stages.size) return;
    if (!this.stageGame) {
      this.stageGame = { id: `g${now.toString(36)}`, votes: new Map(), frames: 0, stage: '', fps: [], lastSeenAt: now };
    }
    const cur = this.stageGame;
    cur.lastSeenAt = now;
    const f = frame.width === GEOMETRY.width ? frame : im.resize(frame, GEOMETRY.width, GEOMETRY.height);
    const fp = fingerprint(f);
    if (cur.fps.length < 12) cur.fps.push(fp);
    const r = this.stages.classify(fp);
    cur.frames += 1;
    if (r.score >= 0.6 && r.nearest <= STAGE_MAX_DISTANCE) cur.votes.set(r.stage, (cur.votes.get(r.stage) || 0) + r.score);
    const ranked = [...cur.votes.entries()].sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((s, [, v]) => s + v, 0);
    if (ranked.length && cur.frames >= STAGE_MIN_FRAMES && ranked[0][1] / total >= 0.6 && ranked[0][0] !== cur.stage) {
      cur.stage = ranked[0][0];
      this.onStage({ gameId: cur.id, stage: cur.stage, done: false, unsure: SHARED_BACKDROP.has(cur.stage) });
    }
  }
  finishStageGame() {
    const g = this.stageGame;
    this.stageGame = null;
    if (!g) return;
    this.stageFps.set(g.id, g.fps);
    while (this.stageFps.size > 12) this.stageFps.delete(this.stageFps.keys().next().value);
    if (g.stage) this.onStage({ gameId: g.id, stage: g.stage, done: true, unsure: SHARED_BACKDROP.has(g.stage) });
    // A game the reader could not place still gets a chip: picking its stage teaches the reader that stage.
    else if (g.frames >= STAGE_MIN_FRAMES) this.onStage({ gameId: g.id, stage: '', done: true, unsure: false });
  }
  // The operator set or corrected a game's stage: keep that game's frames as this station's references.
  learnStage(gameId, stage) {
    const fps = this.stageFps.get(gameId) || (this.stageGame && this.stageGame.id === gameId ? this.stageGame.fps : null);
    if (fps && fps.length) this.stages.addOwn(stage, fps);
    return !!(fps && fps.length);
  }
  async grab(sourceName) {
    const frame = png.decode(await this.screenshot(sourceName, GEOMETRY.width, GEOMETRY.height));
    return frame.width === GEOMETRY.width && frame.height === GEOMETRY.height ? frame : im.resize(frame, GEOMETRY.width, GEOMETRY.height);
  }
  // Full analysis of one frame: is it the VS splash, and which names are on it.
  analyze(frame) {
    const f = frame.width === GEOMETRY.width && frame.height === GEOMETRY.height ? frame : im.resize(frame, GEOMETRY.width, GEOMETRY.height);
    const a = GEOMETRY.vsAnchor;
    let anchorScore = 0;
    let anchorNcc = 0;
    let anchorIou = 0;
    if (this.store.anchor) {
      const patch = im.crop(f, a.x, a.y, a.w, a.h);
      anchorNcc = im.ncc(this.store.anchor.lum, im.luminance(patch));
      anchorIou = im.iou(this.store.anchor.mask, im.whiteMask(patch, GEOMETRY.whiteMin, GEOMETRY.maxChroma));
      anchorScore = Math.max(anchorNcc, anchorIou);
    }
    const p1 = this.readName(f, 1);
    const p2 = this.readName(f, 2);
    const textPresent = p1.hasText && p2.hasText;
    const minScore = Number(this.getCfg().detect.minScore) || 0.6;
    const isVs = textPresent && (this.store.anchor ? anchorScore >= minScore : true);
    return { isVs, anchorScore, anchorNcc, anchorIou, textPresent, p1, p2, frame: f };
  }
  readName(frame, side) {
    const region = GEOMETRY.names[side];
    const cropImg = im.crop(frame, region.x, region.y, region.w, region.h);
    const mask = im.whiteMask(cropImg, GEOMETRY.whiteMin, GEOMETRY.maxChroma);
    const [minH, maxH] = GEOMETRY.letterHeight;
    let letters = im.components(mask, cropImg.width, cropImg.height).filter((c) => {
      const h = c.maxY - c.minY + 1;
      return h >= minH && h <= maxH && c.count >= GEOMETRY.minLetterPixels;
    });
    if (letters.length > 1) {
      // Drop stray highlights far from the text's vertical center (render glints, halos) unless they carry real mass.
      const heights = letters.map((c) => c.maxY - c.minY + 1).sort((x, y) => x - y);
      const medH = heights[Math.floor(heights.length / 2)];
      const total = letters.reduce((s, c) => s + c.count, 0);
      const centerY = letters.reduce((s, c) => s + ((c.minY + c.maxY) / 2) * c.count, 0) / total;
      letters = letters.filter((c) => Math.abs((c.minY + c.maxY) / 2 - centerY) <= medH || c.count >= 0.15 * total);
    }
    const box = { minX: cropImg.width, minY: cropImg.height, maxX: 0, maxY: 0 };
    let pixels = 0;
    for (const c of letters) {
      pixels += c.count;
      if (c.minX < box.minX) box.minX = c.minX;
      if (c.minY < box.minY) box.minY = c.minY;
      if (c.maxX > box.maxX) box.maxX = c.maxX;
      if (c.maxY > box.maxY) box.maxY = c.maxY;
    }
    // Bold italic letters touch each other, so a name is one or a few blobs; judge by mass and width instead.
    const hasText = letters.length >= 1 && pixels >= 120 && box.maxX - box.minX + 1 >= 30;
    if (!hasText) return { letters: letters.length, hasText: false, character: '', score: 0, second: 0, confident: false, alternatives: [] };
    // Keep only the accepted letters in the mask so stray highlights don't distort the template.
    const clean = new Uint8Array(mask.length);
    for (const c of letters) {
      for (let y = c.minY; y <= c.maxY; y += 1) for (let x = c.minX; x <= c.maxX; x += 1) if (mask[y * cropImg.width + x]) clean[y * cropImg.width + x] = 1;
    }
    const cropped = im.maskCrop(clean, cropImg.width, box);
    const norm = im.maskResize(cropped.data, cropped.w, cropped.h, GEOMETRY.normW, GEOMETRY.normH);
    const textCrop = im.crop(cropImg, box.minX, box.minY, box.maxX - box.minX + 1, box.maxY - box.minY + 1);
    return { letters: letters.length, hasText: true, pixels, box, norm, textCrop, ...this.match(norm) };
  }
  match(norm) {
    const scores = new Map();
    for (const t of this.store.items) {
      const s = im.iou(norm, t.mask);
      if (!scores.has(t.character) || scores.get(t.character) < s) scores.set(t.character, s);
    }
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return { character: '', score: 0, second: 0, confident: false, alternatives: [] };
    const [character, score] = ranked[0];
    const second = ranked[1] ? ranked[1][1] : 0;
    const confident = score >= 0.62 && score - second >= 0.06;
    return {
      character: confident || score >= 0.5 ? character : '',
      score, second, confident,
      alternatives: ranked.slice(0, 3).map(([name, s]) => ({ name, score: Number(s.toFixed(3)) })),
    };
  }
  // Persist a frame plus per-side crops/masks so a human can confirm or correct it later.
  makeReviewItem(frame, res, meta = {}, hud = null) {
    const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
    const small = (res && res.frame) || (hud && hud.frame) || frame;
    const item = { id, createdAt: new Date().toISOString(), status: 'pending', kind: res && res.isVs ? (hud ? 'both' : 'vs') : 'hud', anchorScore: Number(((res && res.anchorScore) || 0).toFixed(3)), ...meta };
    const frameFile = `${id} frame.png`;
    // The full 960x540 frame is only needed to learn the VS and "%" anchors from the first confirmed
    // items; after that it is only shown on the training page, so half size (a quarter of the file) does.
    const needFull = !this.store.anchor || !this.store.hudAnchors;
    fs.writeFileSync(path.join(this.samplesDir, frameFile), png.encode(needFull ? small : im.resize(small, small.width / 2, small.height / 2)));
    item.frameFile = frameFile;
    for (const side of [1, 2]) {
      const r = (res && res[`p${side}`]) || { character: '', score: 0, confident: false, alternatives: [], letters: 0 };
      const info = { guess: r.character || '', score: Number((r.score || 0).toFixed(3)), confident: !!r.confident, alternatives: r.alternatives || [], letters: r.letters };
      if (hud && hud[side]) {
        const h = hud[side];
        info.hudGuess = h.character || '';
        info.hudScore = Number((h.score || 0).toFixed(3));
        info.hudCostume = h.costume;
        info.hudConfident = !!h.confident;
        info.hudAlternatives = h.alternatives || [];
        if (h.box) {
          info.hudCropFile = `${id} p${side} hud.png`;
          fs.writeFileSync(path.join(this.samplesDir, info.hudCropFile), png.encode(im.crop(small, h.box.x, h.box.y, h.box.w, h.box.h)));
        }
      }
      if (r.norm) {
        info.maskFile = `${id} p${side} mask.png`;
        fs.writeFileSync(path.join(this.samplesDir, info.maskFile), png.encode(im.maskToImage(r.norm, GEOMETRY.normW, GEOMETRY.normH)));
      }
      if (r.textCrop && r.textCrop.width && r.textCrop.height) {
        info.cropFile = `${id} p${side} crop.png`;
        fs.writeFileSync(path.join(this.samplesDir, info.cropFile), png.encode(r.textCrop));
      }
      item[`p${side}`] = info;
    }
    return item;
  }
  anchorCrop(frame) {
    const a = GEOMETRY.vsAnchor;
    const f = frame.width === GEOMETRY.width ? frame : im.resize(frame, GEOMETRY.width, GEOMETRY.height);
    return im.crop(f, a.x, a.y, a.w, a.h);
  }
}

module.exports = { Detector, TemplateStore, GEOMETRY };
