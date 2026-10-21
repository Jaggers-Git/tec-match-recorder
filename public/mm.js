/* TEC Match Recorder: Metroplex Major helpers shared by the overlay, the /slate screen and the dashboard.
   Ticker lines come from the server (S.branding.mm.ticker): ◆ draws as a gold gem, {days} counts down
   to the first day of the Major, {event} is the tournament loaded from start.gg. */
(() => {
  'use strict';
  const GEM = '<svg class="gem" viewBox="0 0 20 20" aria-hidden="true"><polygon points="10,0 20,10 10,20 0,10" fill="currentColor"/></svg>';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Text with every ◆ (or a typed <> pair) drawn as the gem.
  const gems = (text) => esc(text).split(/\s*(?:◆|&lt;&gt;)\s*/).join(GEM);
  // Whole days from local midnight today to local midnight on the start date; 0 once the weekend begins.
  function daysTo(start) {
    const [y, m, d] = String(start || '2027-02-05').split('-').map(Number);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.max(0, Math.round((new Date(y, m - 1, d) - today) / 86400000));
  }
  // The ticker lines with their fields filled in; a line whose field is empty (no countdown left,
  // no tournament loaded) is dropped instead of shown half-finished.
  function lines(S) {
    const mm = (S && S.branding && S.branding.mm) || {};
    const days = daysTo(mm.start);
    const event = (S && ((S.startgg && S.startgg.tournamentName) || (S.config && S.config.event && S.config.event.name))) || '';
    const out = [];
    for (const raw of mm.ticker || []) {
      if (/\{days\}/.test(raw) && days < 1) continue;
      if (/\{event\}/.test(raw) && !event) continue;
      out.push(raw.replace(/\{days\}/g, days === 1 ? '1' : String(days)).replace(/\{event\}/g, event).replace(/\b1 days\b/i, '1 day'));
    }
    return out;
  }
  // Fades through the lines one at a time. `get` is called at every step, so edits in Settings show up
  // at the next turn without restarting the rotation.
  function ticker(el, get, everyMs = 7000) {
    let i = -1;
    let shown = '';
    function step() {
      const list = get() || [];
      if (!list.length) { el.innerHTML = ''; shown = ''; return; }
      i = (i + 1) % list.length;
      const next = list[i];
      if (next === shown) return;
      el.style.opacity = '0';
      setTimeout(() => { el.innerHTML = gems(next); shown = next; el.style.opacity = '1'; }, shown ? 600 : 0);
    }
    step();
    setInterval(step, everyMs);
    return { refresh() { if (!shown) step(); } };
  }
  window.MM = { GEM, gems, daysTo, lines, ticker };
})();
