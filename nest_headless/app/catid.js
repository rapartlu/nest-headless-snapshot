// Cat identity (#23): a compact appearance descriptor for a cat detection,
// matched by cosine against enrolled samples the way faces are. No neural
// embedding: household cats differ in coat colour, size and fluffiness, so
// a colour histogram plus a few shape and texture numbers does the job.
//
// v2: the crop is the detection box with a margin; the box's histogram has
// the ring's (the surroundings) subtracted from it, so a small cat on a grey
// worktop is described by its coat, not the worktop (v1 named a ginger cat
// as the black one at 0.917 because both crops were mostly kitchen). Coat
// fractions and texture come from the box's inner 60 %.
//
// Vector layout (80): 72 HSV bins (8 hue x 3 sat x 3 val, background-
// subtracted, unit length), dark, ginger, white, sat, val, texture, then
// two size terms from the detection box in frame fractions. A sample from
// an uploaded photo has no frame, so its size terms are unknown: `sized`
// says so and the cosine then runs over the first 78 dims only. Samples
// carry `v`; only the current version is matched.
'use strict';

const VERSION = 2;
const HB = 8, SB = 3, VB = 3, GRID = 64;
const HIST = HB * SB * VB;                       // 72
const DIMS = HIST + 6 + 2;                       // 80
const MARGIN = 0.25;                             // crop margin each side, as a fraction of the box (a box grown by 50%)

function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const s = mx > 1e-6 ? d / mx : 0;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return [h, s, mx];
}
const bin = (hh, ss, vv) => Math.min(HB - 1, Math.floor(hh / 360 * HB)) * SB * VB + Math.min(SB - 1, Math.floor(ss * SB)) * VB + Math.min(VB - 1, Math.floor(vv * VB));

// raw: interleaved RGB (3 channels), w x h - the margin crop; boxRel: {w, h}
// of the detection in frame fractions, or null for an image with no frame
// context; margin: the crop's margin (0 when the image IS the box).
function descriptor(raw, w, h, boxRel, margin = MARGIN) {
  const v = new Float64Array(DIMS);
  const f = 1 / (1 + 2 * margin);                              // the box's share of each side
  const bx0 = w * (1 - f) / 2, by0 = h * (1 - f) / 2, bw = w * f, bh = h * f;
  const histBox = new Float64Array(HIST), histRing = new Float64Array(HIST);
  let nBox = 0, nRing = 0;
  const px = (x, y) => { const i = (Math.min(h - 1, y) * w + Math.min(w - 1, x)) * 3; return [raw[i] / 255, raw[i + 1] / 255, raw[i + 2] / 255]; };
  // one grid over the whole crop: inside the box -> box histogram, outside -> ring
  for (let gy = 0; gy < GRID; gy++) {
    const sy = Math.floor((gy + 0.5) * h / GRID);
    for (let gx = 0; gx < GRID; gx++) {
      const sx = Math.floor((gx + 0.5) * w / GRID);
      const [r, g, b] = px(sx, sy);
      const [hh, ss, vv] = hsv(r, g, b);
      const inBox = sx >= bx0 && sx < bx0 + bw && sy >= by0 && sy < by0 + bh;
      if (inBox) { histBox[bin(hh, ss, vv)]++; nBox++; } else { histRing[bin(hh, ss, vv)]++; nRing++; }
    }
  }
  // subtract the surroundings: what the box has more of than its ring is the cat
  for (let i = 0; i < HIST; i++) v[i] = Math.max(0, histBox[i] / Math.max(1, nBox) - 0.8 * histRing[i] / Math.max(1, nRing));
  let norm = 0; for (let i = 0; i < HIST; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < HIST; i++) v[i] /= norm;
  // coat and texture on the box's inner 60 %
  const ix0 = bx0 + bw * 0.2, iy0 = by0 + bh * 0.2, iw = bw * 0.6, ih = bh * 0.6;
  const grey = new Float64Array(GRID * GRID);
  let dark = 0, ginger = 0, white = 0, sat = 0, val = 0;
  for (let gy = 0; gy < GRID; gy++) {
    const sy = Math.floor(iy0 + (gy + 0.5) * ih / GRID);
    for (let gx = 0; gx < GRID; gx++) {
      const sx = Math.floor(ix0 + (gx + 0.5) * iw / GRID);
      const [r, g, b] = px(sx, sy);
      const [hh, ss, vv] = hsv(r, g, b);
      if (vv < 0.25 && ss < 0.45) dark++;
      if (hh >= 8 && hh <= 50 && ss > 0.3 && vv > 0.25) ginger++;
      if (vv > 0.75 && ss < 0.2) white++;
      sat += ss; val += vv;
      grey[gy * GRID + gx] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }
  const n = GRID * GRID;
  let gsum = 0; for (let i = 0; i < n; i++) gsum += grey[i];
  const gmean = gsum / n; let gvar = 0; for (let i = 0; i < n; i++) gvar += (grey[i] - gmean) ** 2;
  const gstd = Math.sqrt(gvar / n);
  let gx = 0, gy = 0;
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
    if (x + 1 < GRID) gx += Math.abs(grey[y * GRID + x + 1] - grey[y * GRID + x]);
    if (y + 1 < GRID) gy += Math.abs(grey[(y + 1) * GRID + x] - grey[y * GRID + x]);
  }
  const texture = ((gx / (GRID * (GRID - 1))) + (gy / (GRID * (GRID - 1)))) / 2 / (gstd + 1e-3);
  // coat colour carries most of the weight (it is what tells a black cat from a
  // ginger one), texture and size a little more than the rest (they tell the
  // two gingers apart)
  v[HIST] = 1.5 * dark / n; v[HIST + 1] = 1.5 * ginger / n; v[HIST + 2] = 1.0 * white / n;
  v[HIST + 3] = 0.5 * sat / n; v[HIST + 4] = 0.5 * val / n; v[HIST + 5] = 1.5 * Math.min(1, texture);
  const sized = !!(boxRel && boxRel.w > 0 && boxRel.h > 0);
  if (sized) { v[HIST + 6] = 4 * Math.sqrt(boxRel.w * boxRel.h); v[HIST + 7] = 0.5 * Math.min(2, boxRel.w / boxRel.h); }
  return { vec: Array.from(v, (x) => Math.round(x * 1e5) / 1e5), sized, v: VERSION };
}

// cosine over the dims both sides can vouch for
function cosine(a, b, sizedA = true, sizedB = true) {
  const n = sizedA && sizedB ? DIMS : HIST + 6;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / (Math.sqrt(na * nb) || 1);
}

// The crop (box grown by MARGIN each side, clamped) as raw RGB plus a JPEG
// for evidence, and the descriptor. box in frame fractions.
async function describeInJpeg(sharp, jpg, box, { margin = MARGIN, withCrop = true } = {}) {
  const meta = await sharp(jpg).metadata();
  const W = meta.width, H = meta.height;
  const left = Math.max(0, Math.round((box.x - box.w * margin) * W)), top = Math.max(0, Math.round((box.y - box.h * margin) * H));
  const width = Math.max(4, Math.min(W - left, Math.round(box.w * (1 + 2 * margin) * W)));
  const height = Math.max(4, Math.min(H - top, Math.round(box.h * (1 + 2 * margin) * H)));
  const region = sharp(jpg).extract({ left, top, width, height });
  const { data, info } = await region.clone().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const d = descriptor(data, info.width, info.height, { w: box.w, h: box.h }, margin);
  const crop = withCrop ? await region.jpeg({ quality: 88 }).toBuffer() : null;
  return { ...d, size_px: Math.round(Math.max(box.w * W, box.h * H)), crop };
}

// A whole image with no frame context (an uploaded photo or crop that IS the
// cat): no ring to subtract, unsized.
async function describeImage(sharp, jpg) {
  const { data, info } = await sharp(jpg).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const d = descriptor(data, info.width, info.height, null, 0);
  return { ...d, size_px: Math.max(info.width, info.height), crop: null };
}

module.exports = { descriptor, cosine, describeInJpeg, describeImage, MARGIN, DIMS, HIST, VERSION };
