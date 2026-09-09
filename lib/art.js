'use strict';
// Character art packs for the character detector and the title cards.
// The artwork belongs to Nintendo. It is fetched on demand from the community
// TournamentStreamHelper assets repository onto this PC and is never shipped with the app.
const fs = require('node:fs');
const path = require('node:path');

const PACKS = {
  portrait: { remote: 'games/ssbu/portrait', local: 'portraits', pattern: /^chara_0_.+_\d\d\.png$/, label: 'Portraits', approxMb: 23 },
  icon: { remote: 'games/ssbu/base_files/icon', local: 'icons', pattern: /^chara_2_.+_\d\d\.png$/, label: 'Stock icons', approxMb: 4 },
};
const REPO = 'https://api.github.com/repos/joaorb64/StreamHelperAssets/contents';
const SOURCE_URL = 'https://github.com/joaorb64/StreamHelperAssets';
const HEADERS = { 'User-Agent': 'tec-match-recorder' };

async function getJson(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}
async function download(url, file) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

// How many files of a pack are on disk.
function packStatus(dataDir, pack = 'portrait') {
  const p = PACKS[pack];
  if (!p) throw new Error(`Unknown pack "${pack}". Use one of: ${Object.keys(PACKS).join(', ')}`);
  const dir = path.join(dataDir, p.local);
  let files = 0;
  try { files = fs.readdirSync(dir).filter((f) => p.pattern.test(f)).length; } catch { /* not downloaded */ }
  return { pack, label: p.label, dir, files, approxMb: p.approxMb };
}

// Downloads (or completes) a pack. onProgress gets { total, done, failed } as files land.
async function downloadPack(dataDir, pack = 'portrait', onProgress = () => {}) {
  const p = PACKS[pack];
  if (!p) throw new Error(`Unknown pack "${pack}". Use one of: ${Object.keys(PACKS).join(', ')}`);
  const out = path.join(dataDir, p.local);
  fs.mkdirSync(out, { recursive: true });
  const base = await getJson(`${REPO}/games/ssbu/base_files`);
  const config = base.find((e) => e.name === 'config.json');
  if (!config) throw new Error('config.json not found in the assets repository');
  await download(config.download_url, path.join(out, 'config.json'));
  const files = (await getJson(`${REPO}/${p.remote}`)).filter((e) => p.pattern.test(e.name));
  let done = 0;
  let failed = 0;
  onProgress({ total: files.length, done, failed });
  const queue = files.slice();
  const worker = async () => {
    while (queue.length) {
      const entry = queue.shift();
      const target = path.join(out, entry.name);
      if (fs.existsSync(target) && fs.statSync(target).size === entry.size) done += 1;
      else {
        try { await download(entry.download_url, target); done += 1; } catch { failed += 1; }
      }
      onProgress({ total: files.length, done, failed });
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { total: files.length, done, failed, dir: out };
}

module.exports = { PACKS, SOURCE_URL, packStatus, downloadPack };
