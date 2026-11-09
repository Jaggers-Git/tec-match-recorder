'use strict';
/*
 * Live output picture for the dashboard's Broadcast mode.
 *
 * One loop per picture (Program, and Preview while Studio Mode is on) asks the production software for a
 * small frame, one request at a time, and keeps the newest. Pages fetch that frame with short requests
 * (GET /api/live.jpg) rather than a stream that stays open: browsers allow six open connections to a
 * site, and each dashboard tab already holds one for its live updates, so held-open picture streams in
 * two tabs would leave no room for button presses. A loop runs only while a page has asked for its
 * picture in the last few seconds, so a station that never opens Broadcast mode never pays for it.
 *
 * OBS: GetSourceScreenshot of the scene as a 640-wide JPEG, about 5 frames a second for Program and 2 for
 * Preview. vMix has no image over HTTP: its snapshots are files on the vMix PC, so the picture only works
 * when vMix runs on this PC, at 1 to 2 frames a second.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const IDLE_MS = 3000;   // a picture nobody has asked for in this long stops being fetched
const keyOf = (which) => (which === 'preview' ? 'preview' : 'program');

class LiveFeed {
  // grab(which) resolves { buf, type } or null when there is nothing to show (no Preview, not connected).
  // interval(which) is the time between frames in ms.
  constructor({ grab, interval, log }) {
    this.grab = grab;
    this.interval = interval;
    this.log = log;
    this.seq = 0;
    this.wanted = { program: 0, preview: 0 };
    this.running = { program: false, preview: false };
    this.last = { program: null, preview: null };
    this.errors = { program: '', preview: '' };
    this.waiters = { program: [], preview: [] };
  }
  status() {
    const now = Date.now();
    return {
      watching: ['program', 'preview'].filter((k) => now - this.wanted[k] < IDLE_MS).length,
      error: this.errors.program || '',
    };
  }
  // The newest frame of a picture (null when there is none to show). The first request after a quiet
  // spell starts the loop and waits briefly for its first frame.
  async frame(which) {
    const key = keyOf(which);
    this.wanted[key] = Date.now();
    this.loop(key);
    const last = this.last[key];
    if (last && Date.now() - last.at < IDLE_MS) return last;
    await Promise.race([new Promise((resolve) => this.waiters[key].push(resolve)), sleep(2000)]);
    return this.last[key] && Date.now() - this.last[key].at < IDLE_MS ? this.last[key] : null;
  }
  async loop(key) {
    if (this.running[key]) return;
    this.running[key] = true;
    try {
      while (Date.now() - this.wanted[key] < IDLE_MS) {
        const started = Date.now();
        let frame = null;
        try {
          frame = await this.grab(key);
          this.errors[key] = '';
        } catch (e) {
          if (this.errors[key] !== e.message) this.log(`Live ${key} picture: ${e.message}`);
          this.errors[key] = e.message;
        }
        this.seq += 1;
        this.last[key] = frame && frame.buf && frame.buf.length ? { ...frame, seq: this.seq, at: Date.now() } : null;
        const waiters = this.waiters[key];
        this.waiters[key] = [];
        for (const w of waiters) w();
        const wait = frame ? this.interval(key) - (Date.now() - started) : 1000;
        await sleep(Math.max(40, wait));
      }
    } finally {
      this.running[key] = false;
      this.last[key] = null;
    }
  }
}

module.exports = { LiveFeed };
