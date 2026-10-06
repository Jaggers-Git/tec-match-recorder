/* TEC Match Recorder: stream overlay page (loaded by an OBS Browser Source or a vMix Browser input at 1920x1080) */
(() => {
  'use strict';
  const $ = (sel) => document.querySelector(sel);
  const px = (n) => `${Math.round(n)}px`;

  // Two layouts.
  //  bar:     one flush strip (name | score | centre | score | name), used where the game keeps its
  //           HUD elsewhere (Ultimate: bottom of the screen).
  //  notched: two deep name plates above the health bars joined by a thin bridge across the
  //           top-centre, leaving the timer and round-win markers uncovered (Tekken 8, SF6).
  const LAYOUTS = {
    ssbu: { type: 'bar', bar: { x: 300, y: 4, w: 1320, h: 54 }, badge: 56, centerW: 340, endSlant: 22 },
    tekken8: {
      type: 'notched',
      plate1: { x: 212, y: 0, w: 490, h: 62 }, plate2: { x: 1218, y: 0, w: 490, h: 62 },
      bridge: { x: 696, y: 0, w: 528, h: 34 }, badge: 52, endSlant: 22,
    },
    sf6: {
      type: 'notched',
      plate1: { x: 240, y: 0, w: 470, h: 50 }, plate2: { x: 1210, y: 0, w: 470, h: 50 },
      bridge: { x: 704, y: 0, w: 512, h: 34 }, badge: 46, endSlant: 20,
    },
  };
  // Tuesday Takedown scoreboard (bar-type games only). Measured off the TT stream at 1920x1080: plates
  // y 28-84 in a black frame from y 18, the belt logo over the centre gap, 24 px bands underneath.
  // Any of these can be overridden from config.json under overlay.tt.
  const TT = {
    cx: 960, top: 18, plateY: 28, plateH: 56, plateW: 318, gap: 72, cell: 52, pad: 8, slant: 18,
    bandH: 24, bandW: 236, bandSlant: 10, logo: 176, logoY: -12,
    nameSize: 34, subSize: 16, scoreSize: 30, labelSize: 40, labelGap: 18,
  };
  let G = LAYOUTS.ssbu;
  let mode = 'round';
  let showScores = true;
  let S = null;

  function place(el, box) {
    el.style.left = px(box.x);
    el.style.top = px(box.y);
    el.style.width = px(box.w);
    el.style.height = px(box.h);
  }
  // A piece is a white edge layer plus a dark face layer, both clipped to the same shape.
  function piece(box, clip, extraClass) {
    const make = (layer) => {
      const outer = document.createElement('div');
      outer.className = `piece ${extraClass || ''}`;
      place(outer, box);
      const inner = document.createElement('div');
      inner.className = layer;
      if (clip) inner.style.clipPath = clip;
      outer.appendChild(inner);
      return outer;
    };
    return [make('edge'), make('face')];
  }
  const slantLeft = (s) => `polygon(0 0, 100% 0, 100% 100%, ${s}px 100%)`;
  const slantRight = (s) => `polygon(0 0, 100% 0, calc(100% - ${s}px) 100%, 0 100%)`;
  const slantBoth = (s) => `polygon(0 0, 100% 0, calc(100% - ${s}px) 100%, ${s}px 100%)`;

  // Shrink the font until the text fits its area; long tags stay readable instead of being cut.
  function fit(el, text, maxPx) {
    const span = el.querySelector('span');
    span.textContent = text || '';
    let size = maxPx;
    span.style.fontSize = px(size);
    const room = el.clientWidth - 20;
    while (size > 12 && span.scrollWidth > room) { size -= 1; span.style.fontSize = px(size); }
  }

  function layoutBar() {
    const { bar, badge, centerW, endSlant } = G;
    const bw = showScores ? badge : 0;
    const center = { x: Math.round(bar.x + bar.w / 2 - centerW / 2), w: centerW };
    const s1 = { x: center.x - bw, w: bw };
    const s2 = { x: center.x + centerW, w: bw };
    const [edge, face] = piece(bar, slantBoth(endSlant));
    $('#edges').replaceChildren(edge);
    $('#faces').replaceChildren(face);
    const inner = { y: bar.y + 3, h: bar.h - 6 };
    place($('#segC'), { x: center.x, y: inner.y, w: center.w, h: inner.h });
    $('#segC').style.display = 'block';
    place($('#s1'), { x: s1.x, y: inner.y, w: bw, h: inner.h });
    place($('#s2'), { x: s2.x, y: inner.y, w: bw, h: inner.h });
    place($('#p1'), { x: bar.x + endSlant, y: inner.y, w: s1.x - bar.x - endSlant, h: inner.h });
    place($('#p2'), { x: s2.x + bw, y: inner.y, w: bar.x + bar.w - endSlant - (s2.x + bw), h: inner.h });
    place($('#center'), { x: center.x, y: inner.y, w: center.w, h: inner.h });
    // Pips hang just below the bar, hugging the score badges.
    const pipY = bar.y + bar.h + 8;
    return { textH: inner.h, centerH: inner.h, pip1: { xRight: s1.x + bw, y: pipY }, pip2: { xLeft: s2.x, y: pipY } };
  }
  function layoutNotched() {
    const { plate1, plate2, bridge, badge, endSlant } = G;
    const bw = showScores ? badge : 0;
    const [e1, f1] = piece(plate1, slantLeft(endSlant));
    const [e2, f2] = piece(plate2, slantRight(endSlant));
    // The bridge overlaps both plates a little so its face hides the white seams at the joints.
    const bridgeBox = { x: bridge.x - 6, y: bridge.y, w: bridge.w + 12, h: bridge.h };
    const [eb, fb] = piece(bridgeBox, null, 'bridge');
    $('#edges').replaceChildren(e1, e2, eb);
    $('#faces').replaceChildren(f1, f2, fb);
    $('#segC').style.display = 'none';
    const in1 = { y: plate1.y + 3, h: plate1.h - 6 };
    const in2 = { y: plate2.y + 3, h: plate2.h - 6 };
    place($('#s1'), { x: plate1.x + plate1.w - 3 - bw, y: in1.y, w: bw, h: in1.h });
    place($('#s2'), { x: plate2.x + 3, y: in2.y, w: bw, h: in2.h });
    place($('#p1'), { x: plate1.x + endSlant, y: in1.y, w: plate1.w - endSlant - 3 - bw, h: in1.h });
    place($('#p2'), { x: plate2.x + 3 + bw, y: in2.y, w: plate2.w - endSlant - 3 - bw, h: in2.h });
    place($('#center'), { x: bridge.x, y: bridge.y + 3, w: bridge.w, h: bridge.h - 6 });
    return {
      textH: in1.h, centerH: bridge.h - 6,
      pip1: { xRight: plate1.x + plate1.w - 3, y: plate1.y + plate1.h + 8 },
      pip2: { xLeft: plate2.x + 3, y: plate2.y + plate2.h + 8 },
    };
  }
  // Bo3 = 2 pips, Bo5 = 3, Bo1 = none. P1's row is right-aligned to its badge, P2's left-aligned.
  function layoutPips(sizes) {
    const c = S.current;
    const bestOf = Number(c.bestOf) || 1;
    const need = bestOf === 5 ? 3 : bestOf === 3 ? 2 : 0;
    for (const [id, anchor, wins] of [['#w1', sizes.pip1, c.wins1], ['#w2', sizes.pip2, c.wins2]]) {
      const el = $(id);
      if (!need) { el.style.display = 'none'; continue; }
      el.replaceChildren(...Array.from({ length: need }, (_, i) => {
        const d = document.createElement('div');
        d.className = `pip${i < (Number(wins) || 0) ? ' on' : ''}`;
        return d;
      }));
      el.style.display = 'flex';
      el.style.top = px(anchor.y);
      el.style.left = anchor.xLeft !== undefined ? px(anchor.xLeft) : '';
      el.style.right = anchor.xRight !== undefined ? px(1920 - anchor.xRight) : '';
    }
  }
  function centerText() {
    if (!S) return '';
    const c = S.current;
    const game = (S.config.gameList || []).find((g) => g.id === (c.game || 'ssbu'));
    switch (mode) {
      case 'round': return c.round || '';
      case 'score': return `${c.score1 || 0} - ${c.score2 || 0}`;
      case 'set': return c.setLetter || '';
      case 'game': return game ? game.short || game.name : '';
      case 'event': return (S.startgg && S.startgg.tournamentName) || (S.config.event && S.config.event.name) || '';
      default: return '';
    }
  }
  function ttPips(el, wins, need, box, alignRight) {
    if (!need) { el.style.display = 'none'; return; }
    el.replaceChildren(...Array.from({ length: need }, (_, i) => {
      const d = document.createElement('div');
      d.className = `pip${i < (Number(wins) || 0) ? ' on' : ''}`;
      return d;
    }));
    el.style.display = 'flex';
    el.style.top = px(box.y);
    el.style.left = alignRight ? '' : px(box.x);
    el.style.right = alignRight ? px(1920 - box.x) : '';
  }
  function renderTT(ov, demo) {
    const g = { ...TT, ...(ov.tt || {}) };
    const c = S.current;
    const b = S.branding || {};
    const frameB = g.plateY + g.plateH + 4;          // where the black frame ends and the bands begin
    const cell = showScores ? g.cell : 0;
    const ps = Math.round((g.slant * g.plateH) / (frameB - g.top));
    const bestOf = Number(c.bestOf) || 1;
    const need = bestOf === 5 ? 3 : bestOf === 3 ? 2 : 0;
    const sub = [demo ? 'Overlay ready' : centerText(), demo ? 'Best of 3' : bestOf > 1 ? `Best of ${bestOf}` : ''];
    let labelRight = 0;
    for (const side of [1, 2]) {
      const left = side === 1;
      const inner = left ? g.cx - g.gap : g.cx + g.gap;                      // plate edge beside the logo
      const plateX = left ? inner - g.plateW : inner;
      const outer = left ? plateX - cell - g.pad : plateX + g.plateW + cell + g.pad;
      if (left) labelRight = outer;
      const frame = $(`#tt-frame${side}`);
      place(frame, left ? { x: outer, y: g.top, w: g.cx - outer, h: frameB - g.top } : { x: g.cx, y: g.top, w: outer - g.cx, h: frameB - g.top });
      frame.style.clipPath = left ? `polygon(${g.slant}px 0, 100% 0, 100% 100%, 0 100%)` : `polygon(0 0, calc(100% - ${g.slant}px) 0, 100% 100%, 0 100%)`;
      const plate = $(`#tt-plate${side}`);
      place(plate, { x: plateX, y: g.plateY, w: g.plateW, h: g.plateH });
      plate.style.clipPath = left ? `polygon(${ps}px 0, 100% 0, 100% 100%, 0 100%)` : `polygon(0 0, calc(100% - ${ps}px) 0, 100% 100%, 0 100%)`;
      place($(`#tt-n${side}`), left ? { x: plateX + ps, y: g.plateY, w: g.plateW - ps, h: g.plateH } : { x: plateX, y: g.plateY, w: g.plateW - ps, h: g.plateH });
      fit($(`#tt-n${side}`), demo ? `Player ${side}` : c[`p${side}`], g.nameSize);
      const score = $(`#tt-s${side}`);
      score.style.display = cell ? 'flex' : 'none';
      if (cell) {
        place(score, { x: left ? plateX - cell + 4 : plateX + g.plateW - 4, y: g.plateY, w: cell, h: g.plateH });
        const span = score.querySelector('span');
        span.textContent = String(c[`score${side}`] || 0);
        span.style.fontSize = px(g.scoreSize);
      }
      // Band under the plate: round on the left, set format on the right; hidden when there is nothing to say.
      // A long round ("Redemption Winners Round 1") widens its band outwards, up to the plate's width,
      // before the text is shrunk.
      const band = $(`#tt-band${side}`);
      const subEl = $(`#tt-sub${side}`);
      const text = sub[side - 1];
      const span = subEl.querySelector('span');
      span.textContent = text;
      span.style.fontSize = px(g.subSize);
      const bandW = Math.min(g.plateW + cell, Math.max(g.bandW, span.scrollWidth + 28 + g.bandSlant));
      band.style.display = text ? 'block' : 'none';
      place(band, left ? { x: inner - bandW, y: frameB, w: g.cx - (inner - bandW), h: g.bandH } : { x: g.cx, y: frameB, w: inner + bandW - g.cx, h: g.bandH });
      band.style.clipPath = left ? `polygon(0 0, 100% 0, 100% 100%, ${g.bandSlant}px 100%)` : `polygon(0 0, 100% 0, calc(100% - ${g.bandSlant}px) 100%, 0 100%)`;
      place(subEl, left ? { x: inner - bandW + g.bandSlant, y: frameB + 1, w: bandW - g.bandSlant, h: g.bandH } : { x: inner, y: frameB + 1, w: bandW - g.bandSlant, h: g.bandH });
      fit(subEl, text, g.subSize);
      ttPips($(`#tt-w${side}`), c[`wins${side}`], need, { x: left ? inner - bandW - 10 : inner + bandW + 10, y: frameB + 6 }, left);
    }
    const label = $('#tt-label');
    place(label, { x: 0, y: g.plateY, w: Math.max(0, labelRight - g.labelGap), h: g.plateH });
    fit(label, b.label || '', g.labelSize);
    const logoBox = { x: g.cx - g.logo / 2, y: g.logoY, w: g.logo, h: g.logo };
    const img = $('#tt-logo');
    img.hidden = !b.logo;
    $('#tt-emblem').hidden = !!b.logo;
    if (b.logo && img.getAttribute('src') !== b.logo) img.src = b.logo;
    place(img, logoBox);
    place($('#tt-emblem'), { x: g.cx - 60, y: 10, w: 120, h: 120 });
  }
  // Right after "Add overlay to OBS" the server opens a short window in which sample names are shown,
  // so the new layer is visible in OBS before any set is picked.
  let demoTimer = null;
  function demoActive() {
    const until = Number(S && S.overlayDemoUntil) || 0;
    const active = until > Date.now() && !(S.current.p1 || S.current.p2);
    clearTimeout(demoTimer);
    if (active) demoTimer = setTimeout(render, until - Date.now() + 200);
    return active;
  }
  function render() {
    if (!S) return;
    const ov = S.config.overlay || {};
    const game = S.current.game || 'ssbu';
    G = { ...(LAYOUTS[game] || LAYOUTS.ssbu), ...(ov.geometry || {}), ...((ov.byGame && ov.byGame[game]) || {}) };
    mode = ov.center || 'round';
    showScores = ov.scores !== false;
    // Tuesday Takedown: its own scoreboard where the HUD is at the bottom (Ultimate); the notched shape
    // for Tekken and SF6 keeps the timer clear and just takes the TT colours.
    const tt = !!(S.branding && S.branding.theme === 'tt');
    const useTT = tt && G.type !== 'notched';
    document.body.classList.toggle('tt-colors', tt);
    $('#tt').hidden = !useTT;
    $('#tec').hidden = useTT;
    if (useTT) { renderTT(ov, demoActive()); return; }
    const sizes = G.type === 'notched' ? layoutNotched() : layoutBar();
    for (const id of ['#s1', '#s2']) $(id).style.display = showScores ? 'flex' : 'none';
    const demo = demoActive();
    fit($('#p1'), demo ? 'PLAYER 1' : S.current.p1, Math.round(sizes.textH * 0.5));
    fit($('#p2'), demo ? 'PLAYER 2' : S.current.p2, Math.round(sizes.textH * 0.5));
    fit($('#center'), demo ? 'OVERLAY READY' : centerText(), Math.round(sizes.centerH * 0.62));
    layoutPips(sizes);
    for (const [id, val] of [['#s1', S.current.score1], ['#s2', S.current.score2]]) {
      const span = $(id).querySelector('span');
      span.textContent = String(val || 0);
      span.style.fontSize = px(sizes.textH * 0.6);
    }
  }
  // OBS and vMix keep a browser source's page loaded for as long as they run, so after an update the
  // recorder comes back on a new version while this page still has the old look. Reload when that happens.
  let loadedVersion = '';
  function connect() {
    const es = new EventSource('/api/events');
    es.addEventListener('state', (ev) => {
      S = JSON.parse(ev.data);
      if (S.version && loadedVersion && S.version !== loadedVersion) { location.reload(); return; }
      loadedVersion = loadedVersion || S.version || '';
      render();
    });
    es.onerror = () => { /* EventSource reconnects on its own */ };
  }
  // Text is measured for fitting, so re-run once the display font has actually loaded.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => render());
  connect();
})();
