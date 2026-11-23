/* TEC Match Recorder: Texas Esports Conference artwork for the overlay, the screens, the Casters scene and the
   dashboard. The mark and wordmark are TEC's own Conference lockup (brand/tec-lockup-conference-nodate-white.svg
   in the TEC workspace): the four-piece TEC mark in the Unity gradient, the TEXAS ESPORTS / CONFERENCE wordmark
   in white for dark backgrounds. Gradient ids are made unique per drawing, so several can share a page. */
(() => {
  'use strict';
  // The Unity gradient's stops, red through gold and green to blue, as the lockup draws them.
  const UNITY = ['#ff4635', '#fa6529', '#f0b40d', '#ecd402', '#ccdc01', '#7df000', '#45ff00', '#007bff'];
  const UNITY_CSS = `linear-gradient(90deg, ${UNITY.join(', ')})`;
  let n = 0;
  function markParts() {
    n += 1;
    const id = (k) => `conf${n}-${k}`;
    const defs = `<defs>
      <linearGradient id="${id('a')}" x1="111.4" y1="67.7" x2="149" y2="101.8" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ff4635"/><stop offset="1" stop-color="#007bff"/></linearGradient>
      <linearGradient id="${id('b')}" x1="62.6" y1="147.1" x2="77.7" y2="114" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ecd402"/><stop offset=".2" stop-color="#f0b40d"/><stop offset=".8" stop-color="#fa6529"/><stop offset="1" stop-color="#ff4635"/></linearGradient>
      <linearGradient id="${id('c')}" x1="144.2" y1="155.3" x2="184.9" y2="100.1" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#ff4635"/><stop offset="0" stop-color="#45ff00"/><stop offset=".5" stop-color="#007bff"/></linearGradient>
      <linearGradient id="${id('d')}" x1="82" y1="167.1" x2="125.6" y2="193.1" gradientUnits="userSpaceOnUse"><stop offset=".2" stop-color="#ecd402"/><stop offset=".4" stop-color="#ccdc01"/><stop offset=".7" stop-color="#7df000"/><stop offset="1" stop-color="#45ff00"/></linearGradient>
    </defs>`;
    const pieces = `<polygon fill="url(#${id('a')})" points="140.9 97.2 148.5 54 105.4 54 97.7 97.2 115.5 118.8 140.9 97.2"/>
      <polygon fill="url(#${id('b')})" points="87.3 110.2 44.1 110.2 36.5 153.4 79.6 153.4 105 131.8 87.3 110.2"/>
      <polygon fill="url(#${id('c')})" points="148.5 110.2 123.1 131.8 140.9 153.4 184.1 153.4 191.7 110.2 148.5 110.2"/>
      <polygon fill="url(#${id('d')})" points="87.3 164.8 79.6 207.9 122.8 207.9 130.4 164.8 112.6 143.2 87.3 164.8"/>`;
    return { defs, pieces };
  }
  // The mark alone, in the Unity gradient.
  const mark = () => { const p = markParts(); return `<svg class="conf-mark" viewBox="32 50 164 162" aria-hidden="true">${p.defs}${p.pieces}</svg>`; };
  // Mark plus the two-line TEXAS ESPORTS / CONFERENCE wordmark, cropped to the artwork.
  const WORDMARK = 'M217.8,131l6.7-38.3h-13.5l1.8-9.9h39.3l-1.8,9.9h-13.5l-6.7,38.3h-12.4ZM248.4,131l8.5-48.2h36.9l-1.8,9.9h-24.5l-1.6,8.9h22.1l-1.6,9.2h-22.2l-1.8,10.2h24.5l-1.8,9.9h-36.9ZM288.4,131l16-25.3-7.5-23h13.2l5.4,18.1h2.4l9.8-18.1h15.1l-15.6,23,7.1,25.3h-13.5l-4.8-19.2h-2.4l-9.9,19.2h-15.3ZM335.7,131l22.9-48.2h20l5.5,48.2h-12.4l-.7-9.6h-17.2l-4.1,9.6h-13.9ZM357.6,111.9h12.6l-1.6-20h-2.4l-8.6,20ZM387.6,131l1.7-9.8h25.3l2.7-2.3.9-5.4-1.9-2.3h-19.9l-6-7.3,2.4-13.9,8.6-7.3h31.8l-1.7,9.8h-24.6l-2.7,2.3-.7,4.3,1.9,2.3h19.9l6,7.3-2.6,15.1-8.6,7.3h-32.5ZM450.7,131l8.5-48.2h36.9l-1.8,9.9h-24.5l-1.6,8.9h22.1l-1.6,9.2h-22.2l-1.8,10.2h24.5l-1.8,9.9h-36.9ZM494.4,131l1.7-9.8h25.3l2.7-2.3.9-5.4-1.9-2.3h-19.9l-6-7.3,2.4-13.9,8.6-7.3h31.8l-1.7,9.8h-24.6l-2.7,2.3-.7,4.3,1.9,2.3h19.9l6,7.3-2.6,15.1-8.6,7.3h-32.5ZM541.4,131l8.5-48.2h32.5l6,7.3-3.3,18.6-8.6,7.3h-20.2l-2.7,15.1h-12.4ZM558.1,106.6h13.2l2.7-2.3,1.8-9.9-1.9-2.3h-13.2l-2.6,14.5ZM592.5,131l-6-7.3,5.9-33.7,8.6-7.3h28.5l6,7.3-5.9,33.7-8.6,7.3h-28.5ZM601.6,121.7h13.7l2.7-2.3,4.5-25.1-2-2.3h-13.6l-2.7,2.3-4.5,25.1,2,2.3ZM635.9,131l8.5-48.2h33.1l6.1,7.3-3.1,17.3-6.8,5.8,4.1,17.9h-11.7l-3.5-16.4h-11.5l-2.9,16.4h-12.4ZM652.7,105.3h13.7l2.7-2.3,1.5-8.6-1.9-2.3h-13.7l-2.4,13.2ZM692.3,131l6.7-38.3h-13.5l1.8-9.9h39.3l-1.8,9.9h-13.5l-6.7,38.3h-12.4ZM721.7,131l1.7-9.8h25.3l2.7-2.3.9-5.4-1.9-2.3h-19.9l-6-7.3,2.4-13.9,8.6-7.3h31.8l-1.7,9.8h-24.6l-2.7,2.3-.7,4.3,1.9,2.3h19.9l6,7.3-2.6,15.1-8.6,7.3h-32.5ZM214.5,196.6l-6-7.3,5.9-33.7,8.6-7.3h25.1l6,7.3-1.7,9.8h-12l1-5.4-2-2.3h-10.5l-2.7,2.3-4.5,25.1,2,2.3h10.9l2.8-2.3,1-5.5h12l-1.7,9.8-8.6,7.3h-25.5ZM258.3,196.6l-6-7.3,5.9-33.7,8.6-7.3h28.5l6,7.3-5.9,33.7-8.6,7.3h-28.5ZM267.4,187.3h13.7l2.7-2.3,4.5-25.1-2-2.3h-13.6l-2.7,2.3-4.5,25.1,2,2.3ZM301.7,196.6l8.5-48.2h12.7l11.7,30.2,5.4-30.2h11.5l-8.5,48.2h-11.5l-10.9-28.3h-2.4l-5,28.3h-11.5ZM351.8,196.6l8.5-48.2h36.5l-1.8,9.9h-24.2l-1.8,10.2h21.1l-1.6,9.2h-21.1l-3.3,18.9h-12.4ZM393.7,196.6l8.5-48.2h36.9l-1.8,9.9h-24.5l-1.6,8.9h22.1l-1.6,9.2h-22.2l-1.8,10.2h24.5l-1.8,9.9h-36.9ZM438.2,196.6l8.5-48.2h33.1l6.1,7.3-3.1,17.3-6.8,5.8,4.1,17.9h-11.7l-3.5-16.4h-11.5l-2.9,16.4h-12.4ZM455.1,170.9h13.7l2.7-2.3,1.5-8.6-1.9-2.3h-13.7l-2.4,13.2ZM486.7,196.6l8.5-48.2h36.9l-1.8,9.9h-24.5l-1.6,8.9h22.1l-1.6,9.2h-22.2l-1.8,10.2h24.5l-1.8,9.9h-36.9ZM531.3,196.6l8.5-48.2h12.7l11.7,30.2,5.4-30.2h11.5l-8.5,48.2h-11.5l-10.9-28.3h-2.4l-5,28.3h-11.5ZM587.4,196.6l-6-7.3,5.9-33.7,8.6-7.3h25.1l6,7.3-1.7,9.8h-12l1-5.4-2-2.3h-10.5l-2.7,2.3-4.5,25.1,2,2.3h10.9l2.8-2.3,1-5.5h12l-1.7,9.8-8.6,7.3h-25.5ZM625.2,196.6l8.5-48.2h36.9l-1.8,9.9h-24.5l-1.6,8.9h22.1l-1.6,9.2h-22.2l-1.8,10.2h24.5l-1.8,9.9h-36.9Z';
  const lockup = (text = '#fff') => { const p = markParts(); return `<svg class="conf-lockup" viewBox="32 50 734 162" aria-hidden="true">${p.defs}<path fill="${text}" d="${WORDMARK}"/>${p.pieces}</svg>`; };
  window.CONF = { UNITY, UNITY_CSS, mark, lockup };
})();
