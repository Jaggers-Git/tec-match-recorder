'use strict';
/*
 * In-app update from the latest GitHub release: download the portable zip (or the source zip when a release has
 * none), check it, back up the files it replaces, copy it over the app folder and hand back to server.js, which
 * restarts through the supervisor (lib/supervisor.js) in the same console window.
 *
 * Never touched: data/ files that already exist (settings, log, learned templates, logos), node.exe (the runtime
 * that is running), and git checkouts, which update with git pull instead.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const MAX_DOWNLOAD = 300 * 1048576;
const UA = { 'User-Agent': 'tec-match-recorder' };

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// ---------- zip reading (stored and deflate entries; enough for release zips and GitHub source zips) ----------
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('The download is not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('The zip file is damaged');
    const flags = buf.readUInt16LE(p + 8);
    const nameLen = buf.readUInt16LE(p + 28);
    const entry = {
      method: buf.readUInt16LE(p + 10), crc: buf.readUInt32LE(p + 16),
      csize: buf.readUInt32LE(p + 20), usize: buf.readUInt32LE(p + 24), local: buf.readUInt32LE(p + 42),
      // Windows PowerShell's Compress-Archive writes backslashes; the zip format says forward slashes.
      name: buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen).replace(/\\/g, '/'),
    };
    if (entry.csize === 0xffffffff || entry.local === 0xffffffff) throw new Error('The zip uses ZIP64, which the updater does not read');
    entries.push(entry);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return entries;
}
function entryData(buf, e) {
  if (buf.readUInt32LE(e.local) !== 0x04034b50) throw new Error(`The zip file is damaged at ${e.name}`);
  const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
  const raw = buf.subarray(start, start + e.csize);
  let data;
  if (e.method === 0) data = raw;
  else if (e.method === 8) data = zlib.inflateRawSync(raw);
  else throw new Error(`${e.name} uses a compression method the updater does not read`);
  if (data.length !== e.usize || (zlib.crc32 && (zlib.crc32(data) >>> 0) !== e.crc)) throw new Error(`${e.name} failed its checksum`);
  return data;
}

class Updater {
  constructor({ root, dataDir, version, repoUrl, apiUrl, log, onChange }) {
    this.root = root;
    this.dir = path.join(dataDir, 'update');
    this.version = version;
    const m = /github\.com\/([^/]+)\/([^/#?]+)/i.exec(repoUrl || '');
    this.api = apiUrl || (m ? `https://api.github.com/repos/${m[1]}/${m[2]}/releases/latest` : '');
    this.log = log;
    this.onChange = onChange;
    this.job = null;
    this.lastNotify = 0;
  }
  status() { return this.job; }
  set(patch, force = false) {
    this.job = { ...(this.job || {}), ...patch };
    // Download progress arrives many times a second; the dashboard needs a few updates a second at most.
    if (force || Date.now() - this.lastNotify > 300) { this.lastNotify = Date.now(); this.onChange(); }
  }
  // Why this copy cannot update itself, or '' when it can.
  blocker() {
    if (fs.existsSync(path.join(this.root, '.git'))) return 'This folder is a git clone, so update it with git pull instead.';
    try { fs.accessSync(this.root, fs.constants.W_OK); } catch { return `The recorder cannot write to its own folder (${this.root}). Move it somewhere you own, such as C:\\TEC Match Recorder.`; }
    return '';
  }
  async latest() {
    if (!this.api) throw new Error('No GitHub repository is set in package.json yet');
    const r = await fetch(this.api, { headers: { ...UA, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
    if (r.status === 404) throw new Error('No releases published yet');
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const rel = await r.json();
    const version = String(rel.tag_name || '').replace(/^v/i, '');
    const asset = (rel.assets || []).find((a) => /win-x64\.zip$/i.test(a.name || ''));
    return { version, url: rel.html_url, rel, asset };
  }
  async check() {
    const l = await this.latest();
    const upToDate = compareVersions(this.version, l.version) >= 0;
    const why = this.blocker();
    return { version: this.version, latest: l.version, url: l.url, upToDate, canInstall: !upToDate && !why, why };
  }

  // The whole update. Resolves with the version installed; server.js then restarts the app.
  async install() {
    if (this.job && this.job.running) throw new Error('An update is already running');
    const why = this.blocker();
    if (why) throw new Error(why);
    this.job = { running: true, stage: 'checking', received: 0, total: 0, error: '', target: '', at: new Date().toISOString() };
    this.onChange();
    try {
      const l = await this.latest();
      if (compareVersions(this.version, l.version) >= 0) throw new Error(`v${this.version} is already the latest release`);
      this.set({ target: l.version, stage: 'downloading' }, true);
      await fsp.mkdir(this.dir, { recursive: true });
      const zipPath = path.join(this.dir, `v${l.version}.zip`);
      const src = l.asset
        ? { url: l.asset.browser_download_url, size: l.asset.size, digest: l.asset.digest || '' }
        : { url: l.rel.zipball_url, size: 0, digest: '' };
      const buf = await this.download(src, zipPath);
      this.set({ stage: 'unpacking' }, true);
      const files = this.unpack(buf, l.version);
      this.set({ stage: 'installing' }, true);
      const written = await this.apply(files);
      await fsp.rm(zipPath, { force: true });
      this.log(`Updated from v${this.version} to v${l.version} (${written} files)`);
      this.set({ running: false, stage: 'installed', done: written }, true);
      return l.version;
    } catch (e) {
      this.log('Update failed:', e.message);
      this.set({ running: false, stage: 'failed', error: e.message }, true);
      throw e;
    }
  }
  async download({ url, size, digest }, zipPath) {
    const r = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!r.ok) throw new Error(`Download failed: GitHub answered ${r.status}`);
    const total = Number(r.headers.get('content-length')) || size || 0;
    if (total > MAX_DOWNLOAD) throw new Error('The download is unexpectedly large');
    this.set({ total }, true);
    const chunks = [];
    let received = 0;
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > MAX_DOWNLOAD) throw new Error('The download is unexpectedly large');
      chunks.push(Buffer.from(value));
      this.set({ received });
    }
    const buf = Buffer.concat(chunks);
    this.set({ received, stage: 'verifying' }, true);
    // GitHub publishes a SHA-256 for every release asset; a download that does not match is thrown away.
    const want = /^sha256:([0-9a-f]{64})$/i.exec(digest || '');
    if (want && crypto.createHash('sha256').update(buf).digest('hex') !== want[1].toLowerCase()) {
      throw new Error('The download does not match the checksum GitHub published for it');
    }
    await fsp.writeFile(zipPath, buf);
    return buf;
  }
  // Returns [{ rel, data }] for the app files in the zip, after checking it really is this app at the right version.
  unpack(buf, version) {
    const entries = readZip(buf).filter((e) => !e.name.endsWith('/'));
    // The app sits at the zip root (release zips) or one folder down (GitHub source zips).
    const server = entries.filter((e) => /(^|\/)server\.js$/.test(e.name)).sort((a, b) => a.name.length - b.name.length)[0];
    if (!server) throw new Error('The download does not contain the recorder');
    const prefix = server.name.slice(0, -'server.js'.length);
    const pkgEntry = entries.find((e) => e.name === `${prefix}package.json`);
    const pkg = pkgEntry ? JSON.parse(entryData(buf, pkgEntry).toString('utf8')) : {};
    if (pkg.name !== 'tec-match-recorder') throw new Error('The download is not the TEC Match Recorder');
    if (pkg.version !== version) throw new Error(`The download is v${pkg.version}, not v${version}`);
    const files = [];
    for (const e of entries) {
      if (!e.name.startsWith(prefix)) continue;
      const rel = e.name.slice(prefix.length);
      if (!rel || rel.split('/').some((part) => part === '..' || part === '') || path.isAbsolute(rel) || /^[a-z]:/i.test(rel)) continue;
      if (rel === 'node.exe' || rel.startsWith('.git')) continue;
      files.push({ rel, data: entryData(buf, e) });
    }
    return files;
  }
  async apply(files) {
    const backup = path.join(this.dir, `backup-v${this.version}`);
    await fsp.rm(backup, { recursive: true, force: true });
    const replaced = [];
    const created = [];
    try {
      for (const f of files) {
        const dest = path.join(this.root, ...f.rel.split('/'));
        if (!dest.startsWith(this.root + path.sep)) continue;
        const exists = fs.existsSync(dest);
        // data/ belongs to the station: only files it does not have yet (a new example config, a new template).
        if (exists && f.rel.startsWith('data/')) continue;
        if (exists) {
          const old = await fsp.readFile(dest);
          if (old.equals(f.data)) continue;
          const keep = path.join(backup, ...f.rel.split('/'));
          await fsp.mkdir(path.dirname(keep), { recursive: true });
          await fsp.writeFile(keep, old);
          replaced.push({ dest, keep });
        } else {
          created.push(dest);
        }
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, f.data);
      }
    } catch (e) {
      // Put the old version back so the app still starts.
      for (const r of replaced) { try { fs.copyFileSync(r.keep, r.dest); } catch { /* best effort */ } }
      for (const c of created) { try { fs.unlinkSync(c); } catch { /* best effort */ } }
      throw new Error(`Could not write the new files (${e.message}); the old version was put back`);
    }
    return replaced.length + created.length;
  }
}

module.exports = { Updater, compareVersions, readZip };
