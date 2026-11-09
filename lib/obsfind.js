'use strict';
/*
 * OBS's own WebSocket settings on this PC, so a station connects without anyone copying the port and
 * password out of OBS (Tools, WebSocket Server Settings, Show Connect Info).
 *
 * OBS 28 and newer keep them in obs-websocket's config.json: in the user's settings folder for an
 * installed OBS (%APPDATA%\obs-studio on Windows), or beside the program for a portable one
 * (<folder>\config\obs-studio). The portable folder is found from a running obs64.exe.
 *
 * enableWebsocket() ticks "Enable WebSocket server" in that file for a station where it is off. OBS
 * rewrites its settings when it exits, so this only works, and is only offered, while OBS is closed.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const REL = path.join('obs-studio', 'plugin_config', 'obs-websocket', 'config.json');

function standardPaths() {
  const out = [];
  if (process.env.APPDATA) out.push(path.join(process.env.APPDATA, REL));
  if (process.platform === 'darwin') out.push(path.join(os.homedir(), 'Library', 'Application Support', REL));
  if (process.platform === 'linux') out.push(path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), REL));
  return out;
}
// Whether OBS is running, and the portable settings file beside each running copy.
function runningObs() {
  if (process.platform !== 'win32') return Promise.resolve({ running: null, portable: [] });
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process obs64,obs32 -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }'],
      { timeout: 10000, windowsHide: true }, (err, stdout) => {
        const exes = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        // <folder>\bin\64bit\obs64.exe -> <folder>\config\obs-studio\...
        // PowerShell exits non-zero when no OBS is running; only a failed start or a timeout means "unknown".
        const unknown = err && !exes.length && (err.code === 'ENOENT' || err.killed);
        resolve({ running: unknown ? null : exes.length > 0, portable: exes.map((exe) => path.join(path.dirname(exe), '..', '..', 'config', REL)) });
      });
  });
}
function readConfig(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}
// { file, enabled, port, password, obsRunning, portable } or { file: '' } when no settings file was found.
// The password is only returned to the caller, never logged. `hint` is the settings file found last time,
// so a portable OBS is still found while it is closed.
async function findWebsocket(hint = '') {
  const proc = await runningObs();
  const portable = proc.portable.filter((f) => fs.existsSync(f));
  const remembered = hint && fs.existsSync(hint) && !portable.includes(hint) ? [hint] : [];
  for (const file of [...portable, ...remembered, ...standardPaths()]) {
    const j = fs.existsSync(file) ? readConfig(file) : null;
    if (!j) continue;
    return {
      file, portable: portable.includes(file) || remembered.includes(file), obsRunning: proc.running,
      enabled: j.server_enabled === true,
      port: Number(j.server_port) || 4455,
      password: j.auth_required === false ? '' : String(j.server_password || ''),
    };
  }
  return { file: '', portable: false, obsRunning: proc.running, enabled: null, port: 4455, password: '' };
}
async function enableWebsocket(hint = '') {
  const found = await findWebsocket(hint);
  if (found.obsRunning) throw new Error('Close OBS first (it rewrites its settings when it exits), press this again, then start OBS');
  const file = found.file || standardPaths()[0];
  if (!file) throw new Error('Could not tell where OBS keeps its settings on this PC');
  const j = readConfig(file) || {};
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  j.server_enabled = true;
  if (!j.server_port) j.server_port = 4455;
  if (j.auth_required === undefined) j.auth_required = true;
  if (j.auth_required && !j.server_password) j.server_password = crypto.randomBytes(12).toString('base64url');
  // Without this OBS treats the next start as the first and makes up a password of its own.
  j.first_load = false;
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
  return { file, port: j.server_port };
}

module.exports = { findWebsocket, enableWebsocket };
