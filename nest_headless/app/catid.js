// Cat identity (#23): a compact appearance descriptor for a cat detection,
// matched by cosine against enrolled samples the way faces are. No neural
// embedding: household cats differ in coat colour, size and fluffiness, so
// a colour histogram plus a few shape and texture numbers, all computed on
// the crop's inner 60% (less background), does the job and costs nothing.
//
// Vector layout (80): 72 HSV histogram bins (8 hue x 3 sat x 3 val, unit
// length), then dark, ginger, white, sat, val, texture, then two size terms
// (from the detection box in frame fractions). A sample from an uploaded
// photo has no frame, so its size terms are unknown: `sized` says so and the
// cosine then runs over the first 78 dims only.
'use strict';

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

// raw: interleaved RGB (3 channels), w x h; boxRel: {w, h} of the detection in
// frame fractions, or null for an image with no frame context.
function descriptor(raw, w, h, boxRel) {
  const v = new Float64Array(DIMS);
  const grey = new Float64Array(GRID * GRID);
  let dark = 0, ginger = 0, white = 0, sat = 0, val = 0;
  const x0 = w * 0.2, y0 = h * 0.2, sw = w * 0.6, sh = h * 0.6;
  for (let gy = 0; gy < GRID; gy++) {
    const sy = Math.min(h - 1, Math.floor(y0 + (gy + 0.5) * sh / GRID));
    for (let gx = 0; gx < GRID; gx++) {
      const sx = Math.min(w - 1, Math.floor(x0 + (gx + 0.5) * sw / GRID));
      const i = (sy * w + sx) * 3;
      const r = raw[i] / 255, g = raw[i + 1] / 255, b = raw[i + 2] / 255;
      const [hh, ss, vv] = hsv(r, g, b);
      v[Math.min(HB - 1, Math.floor(hh / 360 * HB)) * SB * VB + Math.min(SB - 1, Math.floor(ss * SB)) * VB + Math.min(VB - 1, Math.floor(vv * VB))] += 1;
      if (vv < 0.25 && ss < 0.45) dark++;
      if (hh >= 8 && hh <= 50 && ss > 0.3 && vv > 0.25) ginger++;
      if (vv > 0.75 && ss < 0.2) white++;
      sat += ss; val += vv;
      grey[gy * GRID + gx] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }
  const n = GRID * GRID;
  let norm = 0; for (let i = 0; i < HIST; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < HIST; i++) v[i] /= norm;
  let gsum = 0; for (let i = 0; i < n; i++) gsum += grey[i];
  const gmean = gsum / n; let gvar = 0; for (let i = 0; i < n; i++) gvar += (grey[i] - gmean) ** 2;
  const gstd = Math.sqrt(gvar / n);
  let gx = 0, gy = 0;
  for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
    if (x + 1 < GRID) gx += Math.abs(grey[y * GRID + x + 1] - grey[y * GRID + x]);
    if (y + 1 < GRID) gy += Math.abs(grey[(y + 1) * GRID + x] - grey[y * GRID + x]);
  }
  const texture = ((gx / (GRID * (GRID - 1))) + (gy / (GRID * (GRID - 1)))) / 2 / (gstd + 1e-3);
  // colour fractions and means carry half the weight of the histogram; texture and size a little more,
  // since the two ginger cats differ mostly by fluff and bulk
  v[HIST] = 0.5 * dark / n; v[HIST + 1] = 0.5 * ginger / n; v[HIST + 2] = 0.5 * white / n;
  v[HIST + 3] = 0.5 * sat / n; v[HIST + 4] = 0.5 * val / n; v[HIST + 5] = 1.5 * Math.min(1, texture);
  const sized = !!(boxRel && boxRel.w > 0 && boxRel.h > 0);
  if (sized) { v[HIST + 6] = 4 * Math.sqrt(boxRel.w * boxRel.h); v[HIST + 7] = 0.5 * Math.min(2, boxRel.w / boxRel.h); }
  return { vec: Array.from(v, (x) => Math.round(x * 1e5) / 1e5), sized };
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
  const d = descriptor(data, info.width, info.height, { w: box.w, h: box.h });
  const crop = withCrop ? await region.jpeg({ quality: 88 }).toBuffer() : null;
  return { ...d, size_px: Math.round(Math.max(box.w * W, box.h * H)), crop };
}

// A whole image with no frame context (an uploaded photo or crop): the
// descriptor of the image itself, unsized.
async function describeImage(sharp, jpg) {
  const { data, info } = await sharp(jpg).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const d = descriptor(data, info.width, info.height, null);
  return { ...d, size_px: Math.max(info.width, info.height), crop: null };
}

module.exports = { descriptor, cosine, describeInJpeg, describeImage, MARGIN, DIMS, HIST };
