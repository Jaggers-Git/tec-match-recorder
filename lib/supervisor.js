'use strict';
/*
 * The process the launcher starts stays small: it runs the app (server.js) as a child in the same console
 * window and starts it again when the app exits with RESTART_CODE, which it does after installing an update.
 * The new version then runs in the same black window, with nothing for the operator to do.
 */
const { spawn } = require('node:child_process');

const RESTART_CODE = 75;
const CHILD_ENV = 'TEC_RECORDER_CHILD';

// True in the app process itself; false in the supervisor, which has started the app and should do nothing else.
function supervise(script) {
  if (process.env[CHILD_ENV]) return true;
  let args = process.argv.slice(2);
  const run = () => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit', env: { ...process.env, [CHILD_ENV]: '1' } });
    child.on('exit', (code) => {
      if (code === RESTART_CODE) {
        // The dashboard tab already open reloads itself, so no new browser tab.
        args = [...args.filter((a) => a !== '--no-browser'), '--no-browser'];
        console.log('\nStarting the new version...\n');
        run();
      } else {
        process.exit(code == null ? 1 : code);
      }
    });
  };
  // Ctrl+C reaches the app as well; it exits and the supervisor follows it out.
  process.on('SIGINT', () => {});
  run();
  return false;
}
const underSupervisor = () => !!process.env[CHILD_ENV];

module.exports = { supervise, underSupervisor, RESTART_CODE };
