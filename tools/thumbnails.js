'use strict';
// Generate YouTube title cards (1280x720 PNG) for an event's recordings, in the style of tournament
// VOD channels: player names in banners top-left and top-right, a big VS, character art per side
// (Ultimate), a white round bar along the bottom and the event badge.
//   node tools/thumbnails.js "San Japan 2026"        -> <recordings folder>/_upload/thumbnails/
// Art: data/renders/chara_1_<codename>_<costume>.png when present (full renders), otherwise the
// data/portraits pack (chara_0) shown in a round frame. Games without character data get big names.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const eventName = process.argv[2] || '';
if (!eventName) { console.error('usage: node tools/thumbnails.js "<event name>"'); process.exit(1); }
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
if (!CHROME) { console.error('Chrome or Edge is needed to render the cards'); process.exit(1); }

const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'state.json'), 'utf8'));
const entries = state.log.filter((e) => e.status === 'saved' && e.event === eventName && e.path && fs.existsSync(e.path)).sort((a, b) => (a.ts < b.ts ? -1 : 1));
const seen = new Set();
const rows = entries.filter((e) => (seen.has(e.filename) ? false : (seen.add(e.filename), true)));
if (!rows.length) { console.error(`No saved recordings found for "${eventName}"`); process.exit(1); }
const eventDir = path.dirname(rows[0].path);
const outDir = path.join(eventDir, '_upload', 'thumbnails');
const workDir = path.join(outDir, '_html');
fs.mkdirSync(workDir, { recursive: true });

// Character name -> codename, from the portrait pack's config (names compared without accents/punctuation).
const nameKey = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const codenames = new Map();
try {
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'portraits', 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  for (const [name, info] of Object.entries(conf.character_to_codename || {})) {
    if (!info || !info.codename) continue;
    codenames.set(nameKey(name), info.codename);
    if (info.smashgg_name) codenames.set(nameKey(info.smashgg_name), info.codename);
  }
} catch { /* no pack: cards fall back to names */ }
function artFor(character, costume) {
  const code = codenames.get(nameKey(character));
  if (!code) return null;
  const cc = String(Math.max(0, Number(costume) || 0)).padStart(2, '0');
  const render = path.join(ROOT, 'data', 'renders', `chara_1_${code}_${cc}.png`);
  if (fs.existsSync(render)) return { file: render, kind: 'render' };
  const portrait = path.join(ROOT, 'data', 'portraits', `chara_0_${code}_${cc}.png`);
  if (fs.existsSync(portrait)) return { file: portrait, kind: 'portrait' };
  const any = path.join(ROOT, 'data', 'portraits', `chara_0_${code}_00.png`);
  return fs.existsSync(any) ? { file: any, kind: 'portrait' } : null;
}
const fileUrl = (p) => `file:///${p.replace(/\\/g, '/').replace(/ /g, '%20')}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const GAME_LABEL = { SSBU: 'SMASH ULTIMATE', T8: 'TEKKEN 8', SF6: 'STREET FIGHTER 6' };
const TEC_MARK = 'M159.2,98.1l9-50.9h-50.9l-9,50.9,20.9,25.4,29.9-25.4ZM96,113.4h-50.9l-9,50.9h50.9l29.9-25.4-20.9-25.4ZM168.2,113.4l-29.9,25.4,20.9,25.4h50.9l9-50.9h-50.9ZM96,177.7l-9,50.9h50.9l9-50.9-20.9-25.4-29.9,25.4Z';
const fontUrl = fileUrl(path.join(ROOT, 'public', 'fonts', 'Tomorrow-Bold.ttf'));
// Optional event logo: data/event-logos/<event slug>.png or .jpg (e.g. san-japan-2026.jpg) shown as a tile at the top.
const eventSlug = eventName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const eventLogo = ['png', 'jpg', 'jpeg'].map((ext) => path.join(ROOT, 'data', 'event-logos', `${eventSlug}.${ext}`)).find((p) => fs.existsSync(p)) || null;

function sideHtml(side, name, chars, art) {
  if (art) {
    const img = art.kind === 'render'
      ? `<img class="render" src="${fileUrl(art.file)}" alt="">`
      : `<div class="frame"><img class="portrait" src="${fileUrl(art.file)}" alt=""></div>`;
    return `<div class="side s${side}">${img}</div>`;
  }
  return `<div class="side text s${side}"><div class="bigname"><span>${esc(name).toUpperCase()}</span></div></div>`;
}
function cardHtml(e) {
  const art1 = e.chars1 && e.chars1.length ? artFor(e.chars1[0], e.costume1) : null;
  const art2 = e.chars2 && e.chars2.length ? artFor(e.chars2[0], e.costume2) : null;
  const game = GAME_LABEL[e.game] || '';
  const round = String(e.round || '').toUpperCase().replace(/^POOL (\S+) /, 'POOL $1 · ');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: T; src: url('${fontUrl}'); font-weight: 700; }
  html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; background: #14171c; font-family: T, Bahnschrift, 'Segoe UI', sans-serif; font-weight: 700; color: #fff; }
  .half { position: absolute; inset: 0; }
  .half.left { background: linear-gradient(160deg, #ff5a4c 0%, #ff3d2e 35%, #7a1d16 100%); clip-path: polygon(0 0, 57% 0, 43% 100%, 0 100%); }
  .half.right { background: linear-gradient(200deg, #35e598 0%, #1fc97b 35%, #0c5535 100%); clip-path: polygon(57% 0, 100% 0, 100% 100%, 43% 100%); }
  .stripes { position: absolute; inset: 0; background: repeating-linear-gradient(-30deg, rgba(255,255,255,.06) 0 4px, transparent 4px 22px); }
  .divider { position: absolute; left: 0; top: 0; width: 1280px; height: 720px; background: #fff; clip-path: polygon(56.4% 0, 57.6% 0, 43.6% 100%, 42.4% 100%); }
  .side { position: absolute; top: 96px; bottom: 112px; width: 560px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; }
  .side.s1 { left: 40px; } .side.s2 { right: 40px; }
  .render { max-height: 460px; max-width: 520px; filter: drop-shadow(0 12px 18px rgba(0,0,0,.55)); }
  .frame { width: 380px; height: 380px; border-radius: 50%; overflow: hidden; border: 8px solid #fff; box-shadow: 0 14px 30px rgba(0,0,0,.55); background: #111; }
  .frame .portrait { width: 100%; height: 100%; object-fit: cover; }
  .caption { font-size: 30px; letter-spacing: .12em; text-shadow: 0 3px 8px rgba(0,0,0,.7); }
  .bigname { display: flex; align-items: center; justify-content: center; width: 430px; height: 420px; text-align: center; }
  .side.text { width: 430px; } .side.text.s1 { left: 34px; } .side.text.s2 { right: 34px; }
  .bigname span { font-size: 104px; line-height: .95; letter-spacing: .02em; font-style: italic; text-shadow: 0 6px 16px rgba(0,0,0,.7); word-break: normal; overflow-wrap: normal; hyphens: none; }
  .vs.small { font-size: 150px; top: 275px; }
  .banner { position: absolute; top: 24px; padding: 10px 28px; background: #101216; color: #fff; font-size: 44px; font-style: italic; letter-spacing: .06em; text-transform: uppercase; white-space: nowrap; box-shadow: 0 8px 20px rgba(0,0,0,.45); }
  .banner.b1 { left: 0; clip-path: polygon(0 0, 100% 0, calc(100% - 26px) 100%, 0 100%); padding-right: 54px; border-left: 12px solid #ff3d2e; }
  .banner.b2 { right: 0; clip-path: polygon(26px 0, 100% 0, 100% 100%, 0 100%); padding-left: 54px; border-right: 12px solid #1fc97b; }
  .vs { position: absolute; left: 0; right: 0; top: 250px; text-align: center; font-size: 190px; font-style: italic; line-height: 1; color: #fff;
        text-shadow: 0 0 0 #000, 6px 6px 0 #101216, -6px -6px 0 #101216, 6px -6px 0 #101216, -6px 6px 0 #101216, 0 16px 30px rgba(0,0,0,.6); }
  .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 104px; background: #fff; color: #101216; display: grid; grid-template-columns: 300px 1fr 300px; align-items: center; text-transform: uppercase; }
  .bar .mid { text-align: center; font-size: 60px; letter-spacing: .05em; white-space: nowrap; }
  .bar .tag { font-size: 20px; letter-spacing: .1em; color: #555; padding: 0 22px; line-height: 1.2; white-space: nowrap; }
  .bar .tag.r { text-align: right; }
  .bar .tag .sub { font-size: 12px; letter-spacing: .08em; color: #888; }
  .badge { position: absolute; top: 24px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 12px; background: rgba(16,18,22,.85); padding: 10px 22px; border-radius: 999px; font-size: 22px; letter-spacing: .16em; text-transform: uppercase; }
  .badge svg { width: 34px; height: 34px; }
  .logo { position: absolute; top: 18px; left: 50%; transform: translateX(-50%); width: 132px; height: 132px; background: #fff; border-radius: 14px; box-shadow: 0 10px 24px rgba(0,0,0,.5); overflow: hidden; }
  .logo img { width: 100%; height: 100%; object-fit: contain; }
  </style></head><body>
  <div class="half left"></div><div class="half right"></div><div class="stripes"></div><div class="divider"></div>
  ${sideHtml(1, e.p1, e.chars1, art1)}${sideHtml(2, e.p2, e.chars2, art2)}
  <div class="vs${art1 || art2 ? "" : " small"}">VS</div>
  ${art1 || art2 ? `<div class="banner b1">${esc(e.p1).toUpperCase()}</div><div class="banner b2">${esc(e.p2).toUpperCase()}</div>` : ''}
  ${eventLogo ? `<div class="logo"><img src="${fileUrl(eventLogo)}" alt=""></div>` : `<div class="badge"><svg viewBox="34 45 188 186"><path fill="#FF3D2E" d="${TEC_MARK}"/></svg>${esc(eventName).toUpperCase()}</div>`}
  <div class="bar"><span class="tag l">${esc(eventName).toUpperCase()}<br><span class="sub">TEXAS ESPORTS COLLECTIVE</span></span><span class="mid">${esc(round)}</span><span class="tag r">${esc(game)}</span></div>
  <script>
  // Shrink banners and big names until they fit their space.
  for (const el of document.querySelectorAll('.banner')) { let s = 44; while (el.scrollWidth > 560 && s > 22) { s -= 2; el.style.fontSize = s + 'px'; } }
  for (const el of document.querySelectorAll('.bigname span')) { let s = 104; while ((el.scrollWidth > 430 || el.scrollHeight > 400) && s > 36) { s -= 4; el.style.fontSize = s + 'px'; } }
  const mid = document.querySelector('.bar .mid'); let bs = 60; while (mid.scrollWidth > mid.clientWidth - 16 && bs > 28) { bs -= 2; mid.style.fontSize = bs + 'px'; }
  </script></body></html>`;
}

let n = 0;
const made = [];
for (const e of rows) {
  n += 1;
  const base = `${String(n).padStart(2, '0')} - ${e.set} - ${e.p1} vs ${e.p2}`.replace(/[<>:"/\\|?*]/g, '');
  const htmlFile = path.join(workDir, `${base}.html`);
  const pngFile = path.join(outDir, `${base}.png`);
  fs.writeFileSync(htmlFile, cardHtml(e));
  try {
    execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1280,720', '--virtual-time-budget=2500', `--screenshot=${pngFile}`, fileUrl(htmlFile)], { stdio: 'ignore', timeout: 60000 });
    made.push(pngFile);
    console.log(`${String(n).padStart(2)}. ${path.basename(pngFile)} (${Math.round(fs.statSync(pngFile).size / 1024)} KB)`);
  } catch (err) {
    console.error(`failed: ${base}: ${err.message}`);
  }
}
console.log(`${made.length}/${rows.length} cards in ${outDir}`);
