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
  // `html` turns a line into markup (the overlay passes one that keeps parts together in a narrow corner).
  function ticker(el, get, everyMs = 7000, html = gems) {
    let i = -1;
    let shown = '';
    function step() {
      const list = get() || [];
      if (!list.length) { el.innerHTML = ''; shown = ''; return; }
      i = (i + 1) % list.length;
      const next = list[i];
      if (next === shown) return;
      el.style.opacity = '0';
      setTimeout(() => { el.innerHTML = html(next); shown = next; el.style.opacity = '1'; }, shown ? 600 : 0);
    }
    step();
    const timer = setInterval(step, everyMs);
    return { refresh() { if (!shown) step(); }, stop() { clearInterval(timer); } };
  }

  // The same lines as a crawl: one loop running right to left at `speed` pixels a second (motion.css has
  // the look). A change in the lines waits for the end of the loop, so the crawl never jumps mid-line.
  function crawl(el, get, speed = 90, html = gems) {
    el.classList.add('crawl');
    el.style.opacity = '1';
    el.innerHTML = '<div class="crawl-track"></div>';
    const track = el.firstChild;
    let key = null;
    let pending = false;
    function build() {
      const list = get() || [];
      key = JSON.stringify(list);
      pending = false;
      track.style.animation = 'none';
      if (!list.length) { track.innerHTML = ''; return; }
      const seg = `<span class="crawl-seg">${list.map((l) => `<span class="crawl-item">${html(l)}</span><span class="crawl-gap">${GEM}</span>`).join('')}</span>`;
      track.innerHTML = seg;
      const segW = track.firstElementChild.getBoundingClientRect().width;
      // A hidden bar has no width yet: measure again on the next check.
      if (!el.clientWidth || segW < 2) { key = null; return; }
      // Enough copies to fill the bar twice over, so the loop never shows a gap.
      const reps = Math.max(1, Math.ceil(el.clientWidth / segW));
      track.innerHTML = seg.repeat(reps * 2);
      const dist = segW * reps;
      track.style.setProperty('--crawl-dist', `${-dist}px`);
      void track.offsetWidth;
      track.style.animation = `crawl ${(dist / speed).toFixed(2)}s linear infinite`;
    }
    track.addEventListener('animationiteration', () => { if (pending) build(); });
    build();
    const timer = setInterval(() => {
      if (JSON.stringify(get() || []) === key) return;
      if (!track.style.animation || track.style.animation === 'none') build(); else pending = true;
    }, 2000);
    // The display font changes the widths once it loads: measure again straight away.
    const refit = () => build();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit);
    if (document.fonts && document.fonts.addEventListener) document.fonts.addEventListener('loadingdone', refit);
    return {
      stop() {
        clearInterval(timer);
        if (document.fonts && document.fonts.removeEventListener) document.fonts.removeEventListener('loadingdone', refit);
        el.classList.remove('crawl');
        el.innerHTML = '';
      },
    };
  }

  // The bottom bar's ticker: a crawl while the screens move, the fade above when Settings keeps them still.
  function bar(el, get, { speed = 90, html = gems } = {}) {
    let mode = '';
    let run = null;
    return {
      set(motion) {
        const want = motion ? 'crawl' : 'fade';
        if (want === mode) return;
        mode = want;
        if (run) run.stop();
        el.innerHTML = '';
        run = motion ? crawl(el, get, speed, html) : ticker(el, get, 7000, html);
      },
    };
  }

  // A light that sweeps across an SVG mark now and then: a soft white band, clipped to the shapes `sel`
  // picks inside the SVG, crossing every `every` seconds (motion.css moves it). White art barely changes
  // under it; gold and blue catch the light.
  let shineCount = 0;
  function shine(svg, sel, { delay = 0, every = 7, strength = 0.7 } = {}) {
    if (!svg || svg.querySelector('.shine')) return;
    const NS = 'http://www.w3.org/2000/svg';
    const vb = svg.viewBox && svg.viewBox.baseVal;
    if (!vb || !vb.width) return;
    const id = `tec-shine-${shineCount += 1}`;
    let defs = svg.querySelector('defs');
    if (!defs) { defs = document.createElementNS(NS, 'defs'); svg.prepend(defs); }
    const clip = document.createElementNS(NS, 'clipPath');
    clip.id = `${id}-clip`;
    for (const shape of svg.querySelectorAll(sel)) clip.appendChild(shape.cloneNode(false));
    if (!clip.childNodes.length) return;
    const grad = document.createElementNS(NS, 'linearGradient');
    grad.id = `${id}-grad`;
    grad.innerHTML = `<stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity="${strength}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>`;
    defs.append(clip, grad);
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('clip-path', `url(#${id}-clip)`);
    const w = vb.width * 0.2;
    const band = document.createElementNS(NS, 'rect');
    band.setAttribute('class', 'shine');
    band.setAttribute('x', String(vb.x));
    band.setAttribute('y', String(vb.y - vb.height * 0.5));
    band.setAttribute('width', String(w));
    band.setAttribute('height', String(vb.height * 2));
    band.setAttribute('fill', `url(#${id}-grad)`);
    band.style.setProperty('--shine-from', `${-w * 2}px`);
    band.style.setProperty('--shine-to', `${vb.width + w}px`);
    band.style.animationDuration = `${every}s`;
    band.style.animationDelay = `${delay}s`;
    g.appendChild(band);
    svg.appendChild(g);
  }

  window.MM = { GEM, gems, daysTo, lines, ticker, crawl, bar, shine };
})();
