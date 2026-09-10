'use strict';
// Builds the portable Windows zip: the tracked app files, a Node.js runtime, the launcher and READ ME FIRST.
//   node tools/build-release.js                 -> dist/tec-match-recorder-v<version>-win-x64.zip
//   node tools/build-release.js --node C:\path\to\node.exe   (default: the node.exe running this script)
// Nothing from data/ except config.example.json and the HUD anchor templates goes in; secrets, logs,
// samples and character art stay on the build machine.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const args = process.argv.slice(2);
const nodeArg = args.indexOf('--node');
const nodeExe = nodeArg >= 0 ? args[nodeArg + 1] : process.execPath;
if (!fs.existsSync(nodeExe)) throw new Error(`node.exe not found: ${nodeExe}`);

const name = `tec-match-recorder-v${version}-win-x64`;
const dist = path.join(ROOT, 'dist');
const stage = path.join(dist, name);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// 1. Tracked files only (what git knows about), so nothing local leaks into the zip.
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT }).toString('utf8').split('\0').filter(Boolean);
let copied = 0;
for (const rel of tracked) {
  if (rel === '.gitignore' || rel === '.gitattributes') continue;
  const dest = path.join(stage, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel), dest);
  copied += 1;
}

// 2. Runtime. node.exe is enough to run the app; its license is referenced in THIRD_PARTY.md.
fs.copyFileSync(nodeExe, path.join(stage, 'node.exe'));
const nodeVersion = spawnSync(nodeExe, ['-v']).stdout.toString().trim();

// 3. READ ME FIRST at the top of the zip, with the version filled in.
const readme = fs.readFileSync(path.join(__dirname, 'release', 'READ-ME-FIRST.txt'), 'utf8')
  .replace(/\{version\}/g, version).replace(/\{node\}/g, nodeVersion);
fs.writeFileSync(path.join(stage, 'READ ME FIRST.txt'), readme.replace(/\r?\n/g, '\r\n'));

// 4. Empty data folder so first start has somewhere to write config.json.
fs.mkdirSync(path.join(stage, 'data'), { recursive: true });

// 5. Zip with PowerShell (Windows build for a Windows audience).
const zip = path.join(dist, `${name}.zip`);
fs.rmSync(zip, { force: true });
const ps = spawnSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path "${stage}\\*" -DestinationPath "${zip}" -CompressionLevel Optimal`], { stdio: 'inherit' });
if (ps.status !== 0) throw new Error('Compress-Archive failed');
const mb = (fs.statSync(zip).size / 1048576).toFixed(1);
console.log(`${copied} app files + node ${nodeVersion} -> ${zip} (${mb} MB)`);
