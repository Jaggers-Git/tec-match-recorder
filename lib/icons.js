'use strict';
// Stock-icon matcher: recognizes the fighter portrait drawn in each player's in-game HUD panel
// (Smash Ultimate draws the stock-icon artwork there, costume-colored) against a reference pack
// of chara_2_<codename>_<costume>.png sprites plus the TournamentStreamHelper config.json,
// and against portraits learned from confirmed footage.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const png = require('./png');
const im = require('./image');

const COARSE = 16;
const FINE = 48;
const SCALES = [0.88, 1, 1.12];
// Codenames whose pack names differ from the roster spelling (null = not a fighter, skip).
const CODENAME_OVERRIDES = {
  pzenigame: 'Pokémon Trainer',
  pfushigisou: 'Pokémon Trainer',
  plizardon: 'Pokémon Trainer',
  rosetta: 'Rosalina & Luma',
  simon: 'Simon',
  random: null,
};

function stripAccents(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function nameKey(s) {
  return stripAccents(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Resize an RGBA sprite to size x size and keep only its opaque pixels: their positions, their RGB
// values as bytes, and the mean and spread the correlation needs. Worked out once at load, so each
// comparison is a single pass, and a 48 px sprite takes about 12 KB instead of 37 KB.
function spriteFeatures(img, size) {
  const r = im.resize(img, size, size);
  const n = size * size;
  const px = [];
  for (let i = 0; i < n; i += 1) if (r.data[i * 4 + 3] >= 128) px.push(i);
  const idx = Uint16Array.from(px);
  const rgb = new Uint8Array(idx.length * 3);
  let sum = 0;
  for (let k = 0; k < idx.length; k += 1) {
    for (let c = 0; c < 3; c += 1) { const v = r.data[idx[k] * 4 + c]; rgb[k * 3 + c] = v; sum += v; }
  }
  const count = rgb.length;
  const mean = count ? sum / count : 0;
  let spread = 0;
  for (let k = 0; k < count; k += 1) spread += (rgb[k] - mean) ** 2;
  return { size, idx, rgb, mean, spread, opaque: idx.length };
}
// RGB values of a frame crop resized to size x size (no alpha).
function cropFeatures(img, size) {
  const r = im.resize(img, size, size);
  const n = size * size;
  const rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    rgb[i * 3] = r.data[i * 4];
    rgb[i * 3 + 1] = r.data[i * 4 + 1];
    rgb[i * 3 + 2] = r.data[i * 4 + 2];
  }
  return { size, rgb };
}
// Normalized correlation over the sprite's opaque pixels (all three channels together), in one pass:
// covariance = sum(a*b) - mean(a)*sum(b), crop variance = sum(b*b) - sum(b)^2 / count.
function maskedNcc(sprite, crop) {
  const { idx, rgb: a, mean: ma, spread: va } = sprite;
  const b = crop.rgb;
  const count = a.length;
  if (!count || !va) return 0;
  let sb = 0; let sbb = 0; let sab = 0;
  for (let k = 0; k < idx.length; k += 1) {
    const p = idx[k] * 3;
    const q = k * 3;
    const b0 = b[p]; const b1 = b[p + 1]; const b2 = b[p + 2];
    sb += b0 + b1 + b2;
    sbb += b0 * b0 + b1 * b1 + b2 * b2;
    sab += a[q] * b0 + a[q + 1] * b1 + a[q + 2] * b2;
  }
  const vb = sbb - (sb * sb) / count;
  return vb > 0 ? (sab - ma * sb) / Math.sqrt(va * vb) : 0;
}

class IconPack {
  constructor(dir, rosterNames = [], prefix = 'chara_0') {
    this.dir = dir;
    this.prefix = prefix;
    this.learnedDir = `${dir}-learned`;
    this.icons = [];
    this.roster = new Map(rosterNames.map((n) => [nameKey(n), n]));
    this.load();
  }
  get size() { return this.icons.length; }
  load() {
    this.icons = [];
    if (fs.existsSync(this.dir)) {
      const codeToName = new Map();
      try {
        const config = JSON.parse(fs.readFileSync(path.join(this.dir, 'config.json'), 'utf8').replace(/^﻿/, ''));
        for (const [name, info] of Object.entries(config.character_to_codename || {})) {
          if (info && info.codename) codeToName.set(info.codename, info.smashgg_name || name);
        }
      } catch { /* names fall back to codenames */ }
      const pattern = new RegExp(`^${this.prefix}_(.+)_(\\d\\d)\\.png$`);
      for (const f of fs.readdirSync(this.dir)) {
        const m = pattern.exec(f);
        if (!m) continue;
        let img;
        try { img = png.decode(fs.readFileSync(path.join(this.dir, f))); } catch { continue; }
        if (CODENAME_OVERRIDES[m[1]] === null) continue;
        const raw = CODENAME_OVERRIDES[m[1]] || codeToName.get(m[1]) || m[1];
        const character = this.roster.get(nameKey(raw)) || raw;
        this.icons.push({ file: f, codename: m[1], costume: Number(m[2]), character, learned: false, coarse: spriteFeatures(img, COARSE), fine: spriteFeatures(img, FINE) });
      }
    }
    if (fs.existsSync(this.learnedDir)) {
      for (const f of fs.readdirSync(this.learnedDir)) {
        const m = /^(.+) [0-9a-f]{8}\.png$/.exec(f);
        if (!m) continue;
        let img;
        try { img = png.decode(fs.readFileSync(path.join(this.learnedDir, f))); } catch { continue; }
        this.icons.push({ file: f, codename: '', costume: -1, character: m[1], learned: true, coarse: spriteFeatures(img, COARSE), fine: spriteFeatures(img, FINE) });
      }
    }
  }
  // Keep a confirmed HUD crop as an extra reference (fully opaque mask).
  addLearned(character, cropImg) {
    fs.mkdirSync(this.learnedDir, { recursive: true });
    const safe = String(character).replace(/[^\w.& -]/g, '').trim() || 'unknown';
    const file = `${safe} ${crypto.randomUUID().slice(0, 8)}.png`;
    fs.writeFileSync(path.join(this.learnedDir, file), png.encode(cropImg));
    this.icons.push({ file, codename: '', costume: -1, character, learned: true, coarse: spriteFeatures(cropImg, COARSE), fine: spriteFeatures(cropImg, FINE) });
    return file;
  }
  summary() {
    const chars = new Set(this.icons.map((i) => i.character));
    return { icons: this.icons.length, characters: chars.size, learned: this.icons.filter((i) => i.learned).length };
  }
  // Find the best sprite inside a frame region. The portrait's size and position are fixed by the HUD
  // layout, so only a small window of offsets and scales around the expected box is searched.
  // Two passes: every sprite is ranked on a 16 px copy in every window, then the shortlist is scored on
  // a 48 px copy. The ranking is the same as before the one-pass correlation; the shortlist is a little
  // longer (16), so the answer can only match or improve on the old one. `only` limits the search to one
  // character's sprites, for checking a portrait that is already known (the detector's lock); with one
  // character there is no runner-up, so confidence rests on the score alone.
  match(frame, box, { margin = 6, step = 3, shortlist = 16, only = '' } = {}) {
    const pool = only ? this.icons.filter((i) => i.character === only) : this.icons;
    if (!pool.length) return { character: '', costume: -1, score: 0, second: 0, confident: false, alternatives: [] };
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    const windows = [];
    for (const scale of SCALES) {
      const w = Math.round(box.w * scale);
      const h = Math.round(box.h * scale);
      for (let dy = -margin; dy <= margin; dy += step) {
        for (let dx = -margin; dx <= margin; dx += step) {
          const x = Math.round(cx - w / 2 + dx);
          const y = Math.round(cy - h / 2 + dy);
          const crop = im.crop(frame, x, y, w, h);
          if (crop.width !== w || crop.height !== h) continue;
          windows.push({ x, y, w, h, scale, crop, coarse: only ? null : cropFeatures(crop, COARSE), fine: null });
        }
      }
    }
    if (!windows.length) return { character: '', costume: -1, score: 0, second: 0, confident: false, alternatives: [] };
    let shortlisted = pool;
    if (!only) {
      const candidates = [];
      for (const icon of pool) {
        let best = -1;
        for (const win of windows) {
          const s = maskedNcc(icon.coarse, win.coarse);
          if (s > best) best = s;
        }
        candidates.push({ icon, coarseScore: best });
      }
      candidates.sort((a, b) => b.coarseScore - a.coarseScore);
      shortlisted = candidates.slice(0, shortlist).map((c) => c.icon);
    }
    const results = [];
    for (const icon of shortlisted) {
      let best = -1;
      let bestWin = null;
      for (const win of windows) {
        if (!win.fine) win.fine = cropFeatures(win.crop, FINE);
        const s = maskedNcc(icon.fine, win.fine);
        if (s > best) { best = s; bestWin = win; }
      }
      results.push({ icon, score: best, win: bestWin });
    }
    results.sort((a, b) => b.score - a.score);
    const top = results[0];
    const other = results.find((r) => r.icon.character !== top.icon.character);
    const second = other ? other.score : 0;
    // A real portrait crop has plenty of luminance contrast (spread 45+); a flat panel or gradient
    // (spread under 10) can still correlate with a flat silhouette sprite, so it never counts.
    const lum = im.luminance(top.win.crop);
    const mean = lum.reduce((s, v) => s + v, 0) / lum.length;
    const spread = Math.sqrt(lum.reduce((s, v) => s + (v - mean) ** 2, 0) / lum.length);
    const flat = spread < 25;
    // True portraits score 0.65-0.75 with a wide gap to other fighters; menus and splash screens
    // top out around 0.65 with almost no gap, so the margin is the discriminator. A check against one
    // known character has no runner-up, so it needs a true portrait's score instead.
    const confident = only ? !flat && top.score >= 0.65 : !flat && top.score >= 0.6 && top.score - second >= 0.08;
    return {
      character: top.icon.character, codename: top.icon.codename, costume: top.icon.costume, file: top.icon.file, learned: top.icon.learned,
      score: top.score, second, confident, flat, spread: Number(spread.toFixed(1)),
      box: { x: top.win.x, y: top.win.y, w: top.win.w, h: top.win.h, scale: top.win.scale },
      alternatives: results.slice(0, 5).map((r) => ({ name: r.icon.character, costume: r.icon.costume, score: Number(r.score.toFixed(3)) })),
    };
  }
}

module.exports = { IconPack, nameKey, spriteFeatures, cropFeatures, maskedNcc };
