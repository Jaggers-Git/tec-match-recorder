'use strict';
// Plain-JS image operations on { width, height, data: Uint8Array RGBA } and binary masks.

function create(width, height) {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

function crop(img, x, y, w, h) {
  const x0 = Math.max(0, Math.min(img.width, Math.round(x)));
  const y0 = Math.max(0, Math.min(img.height, Math.round(y)));
  const cw = Math.max(0, Math.min(Math.round(w), img.width - x0));
  const ch = Math.max(0, Math.min(Math.round(h), img.height - y0));
  const out = create(cw, ch);
  for (let row = 0; row < ch; row += 1) {
    const src = ((y0 + row) * img.width + x0) * 4;
    out.data.set(img.data.subarray(src, src + cw * 4), row * cw * 4);
  }
  return out;
}

// Area-average resize (good for downscaling; acceptable for modest upscaling).
function resize(img, w, h) {
  if (img.width === w && img.height === h) return img;
  const out = create(w, h);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let yy = y0; yy < y1; yy += 1) {
        for (let xx = x0; xx < x1; xx += 1) {
          const i = (yy * img.width + xx) * 4;
          r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; a += img.data[i + 3];
          n += 1;
        }
      }
      const o = (y * w + x) * 4;
      out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n; out.data[o + 3] = a / n;
    }
  }
  return out;
}

function luminance(img) {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const p = i * 4;
    out[i] = 0.299 * img.data[p] + 0.587 * img.data[p + 1] + 0.114 * img.data[p + 2];
  }
  return out;
}

// 1 where every channel is at least minChannel and the pixel is close to neutral (white UI text,
// not tinted highlights such as glowing hair or a halo).
function whiteMask(img, minChannel, maxChroma = 255) {
  const n = img.width * img.height;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) {
    const p = i * 4;
    const r = img.data[p];
    const g = img.data[p + 1];
    const b = img.data[p + 2];
    const lo = Math.min(r, g, b);
    const hi = Math.max(r, g, b);
    if (lo >= minChannel && hi - lo <= maxChroma) out[i] = 1;
  }
  return out;
}

// 4-connected components of a binary mask with bounding boxes.
function components(mask, w, h) {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const comps = [];
  let next = 1;
  for (let start = 0; start < w * h; start += 1) {
    if (!mask[start] || labels[start]) continue;
    const id = next;
    next += 1;
    let sp = 0;
    stack[sp] = start; sp += 1;
    labels[start] = id;
    const c = { minX: w, minY: h, maxX: 0, maxY: 0, count: 0 };
    while (sp > 0) {
      sp -= 1;
      const j = stack[sp];
      const x = j % w;
      const y = (j - x) / w;
      c.count += 1;
      if (x < c.minX) c.minX = x;
      if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y;
      if (y > c.maxY) c.maxY = y;
      if (x > 0 && mask[j - 1] && !labels[j - 1]) { labels[j - 1] = id; stack[sp] = j - 1; sp += 1; }
      if (x < w - 1 && mask[j + 1] && !labels[j + 1]) { labels[j + 1] = id; stack[sp] = j + 1; sp += 1; }
      if (y > 0 && mask[j - w] && !labels[j - w]) { labels[j - w] = id; stack[sp] = j - w; sp += 1; }
      if (y < h - 1 && mask[j + w] && !labels[j + w]) { labels[j + w] = id; stack[sp] = j + w; sp += 1; }
    }
    comps.push(c);
  }
  return comps;
}

function maskCrop(mask, w, box) {
  const bw = box.maxX - box.minX + 1;
  const bh = box.maxY - box.minY + 1;
  const out = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y += 1) {
    for (let x = 0; x < bw; x += 1) out[y * bw + x] = mask[(box.minY + y) * w + box.minX + x];
  }
  return { w: bw, h: bh, data: out };
}

// Resize a binary mask by area coverage; a target pixel is set when enough of its source block is set.
function maskResize(mask, w, h, tw, th, fill = 0.35) {
  const out = new Uint8Array(tw * th);
  const sx = w / tw;
  const sy = h / th;
  for (let y = 0; y < th; y += 1) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
    for (let x = 0; x < tw; x += 1) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
      let set = 0; let n = 0;
      for (let yy = y0; yy < y1; yy += 1) for (let xx = x0; xx < x1; xx += 1) { set += mask[yy * w + xx]; n += 1; }
      out[y * tw + x] = n && set / n >= fill ? 1 : 0;
    }
  }
  return out;
}

function iou(a, b) {
  let inter = 0; let union = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] && b[i]) inter += 1;
    if (a[i] || b[i]) union += 1;
  }
  return union ? inter / union : 0;
}

// Normalized cross-correlation of two equal-length luminance arrays (contrast/brightness invariant).
function ncc(a, b) {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let ma = 0; let mb = 0;
  for (let i = 0; i < n; i += 1) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let cov = 0; let va = 0; let vb = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - ma; const db = b[i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  return va && vb ? cov / Math.sqrt(va * vb) : 0;
}

function maskToImage(mask, w, h) {
  const img = create(w, h);
  for (let i = 0; i < w * h; i += 1) {
    const v = mask[i] ? 255 : 0;
    img.data[i * 4] = v; img.data[i * 4 + 1] = v; img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
  }
  return img;
}
function imageToMask(img) {
  const n = img.width * img.height;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = img.data[i * 4] > 127 ? 1 : 0;
  return out;
}

module.exports = { create, crop, resize, luminance, whiteMask, components, maskCrop, maskResize, iou, ncc, maskToImage, imageToMask };
