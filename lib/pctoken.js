'use strict';
/*
 * The start.gg API token, saved once per PC (per Windows user) outside the app folder, so every copy of
 * the recorder on this PC finds it: a new release unzipped next to the old one, a second station folder,
 * or a fresh install after the old folder was deleted. Nobody has to dig the token out again.
 *
 *   Windows:  %APPDATA%\TEC Match Recorder\startgg.json
 *   elsewhere: ~/.config/tec-match-recorder/startgg.json
 *
 * TEC_PC_DIR overrides the folder (tests use it to stay out of the real one).
 * File: { "token": "...", "savedAt": "<ISO date it was pasted, or null when copied from an older config>" }
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function folder() {
  if (process.env.TEC_PC_DIR) return process.env.TEC_PC_DIR;
  if (process.platform === 'win32' && process.env.APPDATA) return path.join(process.env.APPDATA, 'TEC Match Recorder');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'tec-match-recorder');
}
const file = () => path.join(folder(), 'startgg.json');

// { token, savedAt } or null when this PC has none (or the file is unreadable).
function read() {
  try {
    const text = fs.readFileSync(file(), 'utf8');
    const j = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    const token = typeof j.token === 'string' ? j.token.trim() : '';
    return token ? { token, savedAt: typeof j.savedAt === 'string' ? j.savedAt : null } : null;
  } catch { return null; }
}

// Throws when the folder cannot be written; callers then keep the token in data/config.json as before.
function write(token, savedAt = new Date().toISOString()) {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ token, savedAt }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

function clear() {
  try { fs.unlinkSync(file()); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

module.exports = { folder, file, read, write, clear };
