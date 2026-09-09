'use strict';
// Downloads a Smash Ultimate character art pack for the character detector (see lib/art.js).
//   node tools/fetch-icons.js portrait   -> data/portraits  (the HUD/character-select portraits, ~23 MB)
//   node tools/fetch-icons.js icon       -> data/icons      (the small stock icons, ~4 MB)
// The same download is available from Settings in the dashboard.
const path = require('node:path');
const { PACKS, downloadPack } = require('../lib/art');

(async () => {
  const pack = process.argv[2] || 'portrait';
  if (!PACKS[pack]) throw new Error(`Unknown pack. Use one of: ${Object.keys(PACKS).join(', ')}`);
  let shown = 0;
  const result = await downloadPack(path.join(__dirname, '..', 'data'), pack, (p) => {
    if (p.done - shown >= 100) { shown = p.done; console.log(`${p.done}/${p.total}`); }
  });
  console.log(`done: ${result.done} files, ${result.failed} failed, folder ${result.dir}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
