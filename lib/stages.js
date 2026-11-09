'use strict';
/*
 * Stage recognition for Smash Ultimate, from the same 960x540 frames the character detector reads.
 *
 * A stage is told by its backdrop. Each in-game frame becomes a small fingerprint of the middle band of
 * the picture (the top strip carries stream overlays, the bottom the damage display and player cams):
 *   - a colour histogram (hue, saturation, brightness), which ignores where the camera points, and
 *   - a coarse layout grid (mean colour of 16 x 6 cells), which tells apart stages that share colours
 *     but not shape (Battlefield's top platform, which Small Battlefield does not have).
 * A frame is matched against reference fingerprints of each stage (nearest neighbours), and a game's
 * stage is the vote of its frames. References ship with the recorder (lib/stages-ref.json, fingerprints
 * only, no pictures) and a station adds its own when the operator corrects a stage.
 */
const fs = require('node:fs');
const path = require('node:path');

const STAGES = ['Battlefield', 'Small Battlefield', 'Final Destination', 'Pokémon Stadium 2', 'Smashville', 'Town and City', 'Kalos Pokémon League', 'Hollow Bastion'];
const BAND = { top: 0.1, bottom: 0.7 };
const HUE = 12; const SAT = 3; const VAL = 4;
const GRID_W = 16; const GRID_H = 6;
const HIST_BINS = HUE * SAT * VAL;

// Fingerprint of one RGBA frame (any size; 960x540 is what the detector has).
function fingerprint(frame) {
  const { width: W, height: H, data } = frame;
  const y0 = Math.floor(H * BAND.top); const y1 = Math.floor(H * BAND.bottom);
  const hist = new Float32Array(HIST_BINS);
  const cells = new Float64Array(GRID_W * GRID_H * 3);
  const counts = new Uint32Array(GRID_W * GRID_H);
  const step = Math.max(1, Math.round(W / 320));
  let n = 0;
  for (let y = y0; y < y1; y += step) {
    const gy = Math.min(GRID_H - 1, Math.floor(((y - y0) / (y1 - y0)) * GRID_H));
    for (let x = 0; x < W; x += step) {
      const i = (y * W + x) * 4;
      const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
      const max = Math.max(r, g, b); const min = Math.min(r, g, b);
      const v = max / 255; const s = max ? (max - min) / max : 0;
      let h = 0;
      if (max !== min) {
        if (max === r) h = ((g - b) / (max - min) + 6) % 6;
        else if (max === g) h = (b - r) / (max - min) + 2;
        else h = (r - g) / (max - min) + 4;
      }
      const hb = Math.min(HUE - 1, Math.floor((h / 6) * HUE));
      const sb = Math.min(SAT - 1, Math.floor(s * SAT));
      const vb = Math.min(VAL - 1, Math.floor(v * VAL));
      hist[(hb * SAT + sb) * VAL + vb] += 1;
      n += 1;
      const gx = Math.min(GRID_W - 1, Math.floor((x / W) * GRID_W));
      const c = gy * GRID_W + gx;
      cells[c * 3] += r; cells[c * 3 + 1] += g; cells[c * 3 + 2] += b; counts[c] += 1;
    }
  }
  for (let k = 0; k < HIST_BINS; k += 1) hist[k] = Math.sqrt(hist[k] / n); // square roots: Hellinger by dot product
  const grid = new Float32Array(GRID_W * GRID_H * 3);
  let mean = 0;
  for (let c = 0; c < counts.length; c += 1) for (let k = 0; k < 3; k += 1) { grid[c * 3 + k] = cells[c * 3 + k] / Math.max(1, counts[c]); mean += grid[c * 3 + k]; }
  mean /= grid.length;
  let sd = 0;
  for (let k = 0; k < grid.length; k += 1) sd += (grid[k] - mean) ** 2;
  sd = Math.sqrt(sd / grid.length) || 1;
  for (let k = 0; k < grid.length; k += 1) grid[k] = (grid[k] - mean) / sd;
  return { hist, grid };
}
// 0 = same, larger = more different. The histogram part ignores the camera; the grid part keeps layout.
function distance(a, b, gridWeight = 0.35) {
  let bc = 0;
  for (let k = 0; k < HIST_BINS; k += 1) bc += a.hist[k] * b.hist[k];
  const dh = Math.sqrt(Math.max(0, 1 - bc));
  let corr = 0;
  for (let k = 0; k < a.grid.length; k += 1) corr += a.grid[k] * b.grid[k];
  const dg = (1 - corr / a.grid.length) / 2;
  return dh + gridWeight * dg;
}
// Fingerprints travel as base64 bytes: histogram roots and grid z-scores scaled to one byte each.
function pack(fp) {
  const buf = Buffer.alloc(HIST_BINS + fp.grid.length);
  for (let k = 0; k < HIST_BINS; k += 1) buf[k] = Math.round(Math.min(1, fp.hist[k]) * 255);
  for (let k = 0; k < fp.grid.length; k += 1) buf[HIST_BINS + k] = Math.max(0, Math.min(255, Math.round(fp.grid[k] * 40 + 128)));
  return buf.toString('base64');
}
function unpack(s) {
  const buf = Buffer.from(s, 'base64');
  const hist = new Float32Array(HIST_BINS); const grid = new Float32Array(buf.length - HIST_BINS);
  for (let k = 0; k < HIST_BINS; k += 1) hist[k] = buf[k] / 255;
  for (let k = 0; k < grid.length; k += 1) grid[k] = (buf[HIST_BINS + k] - 128) / 40;
  return { hist, grid };
}

class StageReader {
  // refFile: the references shipped with the app; ownFile: this station's own, added by corrections.
  constructor({ refFile = path.join(__dirname, 'stages-ref.json'), ownFile = '' } = {}) {
    this.refFile = refFile;
    this.ownFile = ownFile;
    this.refs = [];
    this.load();
  }
  load() {
    this.refs = [];
    for (const [file, own] of [[this.refFile, false], [this.ownFile, true]]) {
      if (!file || !fs.existsSync(file)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [stage, list] of Object.entries(j.stages || {})) for (const s of list) this.refs.push({ stage, own, fp: unpack(s) });
      } catch { /* unreadable reference file: skip it */ }
    }
  }
  get size() { return this.refs.length; }
  // Nearest references to one frame: { stage, score (0..1, higher is surer), margin over the next stage }.
  classify(fp, k = 5) {
    if (!this.refs.length) return { stage: '', score: 0, margin: 0 };
    const near = this.refs.map((r) => ({ stage: r.stage, d: distance(fp, r.fp) })).sort((a, b) => a.d - b.d).slice(0, k);
    const votes = new Map();
    for (const nb of near) votes.set(nb.stage, (votes.get(nb.stage) || 0) + 1 / (nb.d + 0.02));
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    const total = ranked.reduce((s, [, v]) => s + v, 0);
    return { stage: ranked[0][0], score: ranked[0][1] / total, margin: (ranked[0][1] - (ranked[1] ? ranked[1][1] : 0)) / total, nearest: near[0].d };
  }
  // The station's own references: frames of a game whose stage the operator set or confirmed.
  addOwn(stage, fps) {
    if (!this.ownFile || !STAGES.includes(stage)) return;
    let j = { stages: {} };
    try { j = JSON.parse(fs.readFileSync(this.ownFile, 'utf8')); } catch { /* first one */ }
    const list = (j.stages[stage] = j.stages[stage] || []);
    for (const fp of fps.slice(0, 12)) list.push(pack(fp));
    // Newest 60 per stage are plenty.
    if (list.length > 60) list.splice(0, list.length - 60);
    fs.mkdirSync(path.dirname(this.ownFile), { recursive: true });
    fs.writeFileSync(this.ownFile, JSON.stringify(j));
    this.load();
  }
}

module.exports = { STAGES, StageReader, fingerprint, distance, pack, unpack };
