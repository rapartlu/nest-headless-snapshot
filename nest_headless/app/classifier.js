// Tiny per-camera image classifier (logistic regression over a downscaled
// grayscale crop). Weights are trained offline (see tools/train_door_model.py
// in the nest-capture-kit) and shipped as JSON in the HA config dir so they
// can be retrained without rebuilding the add-on:
//
//   /homeassistant/nest_models/<camera>.json
//   { "label": "door_open", "width": 64, "height": 96,
//     "mean": [...], "std": [...], "weights": [...], "bias": -1.23,
//     "threshold": 0.5, "trained": "2026-08-28", "samples": {"pos": 40, "neg": 200} }
//
// Inference cost: one 64x96 dot product — microseconds, no native deps.

'use strict';

const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const MODELS_DIRS = [path.join(process.env.HA_CONFIG_DIR || '/homeassistant', 'nest_models'), '/config/nest_models'];

const cache = {}; // camera -> { model, mtimeMs } | { missing: true }

function loadModel(camera) {
  const name = camera.replace(/^camera\./, '') + '.json';
  for (const dir of MODELS_DIRS) {
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      const c = cache[camera];
      if (c && c.mtimeMs === st.mtimeMs) return c.model;
      const model = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!model.weights || !model.width || !model.height) throw new Error('bad model shape');
      cache[camera] = { model, mtimeMs: st.mtimeMs };
      console.log(`[nest_headless] loaded model ${p} (label=${model.label}, trained=${model.trained})`);
      return model;
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`[nest_headless] model ${p}: ${e.message}`);
    }
  }
  cache[camera] = { missing: true };
  return null;
}

// Bilinear grayscale resize of a decoded RGBA buffer to w*h floats in [0,1].
// `sub` optionally restricts the source to a relative region [x0,y0,x1,y1]
// (must match the trainer's SUBCROP so train and inference see the same view).
function toGray(img, w, h, sub) {
  const [rx0, ry0, rx1, ry1] = sub || [0, 0, 1, 1];
  const ox = rx0 * img.width, oy = ry0 * img.height;
  const srcW = (rx1 - rx0) * img.width, srcH = (ry1 - ry0) * img.height;
  const out = new Float64Array(w * h);
  const sx = srcW / w;
  const sy = srcH / h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx = ox + (x + 0.5) * sx - 0.5;
      const fy = oy + (y + 0.5) * sy - 0.5;
      const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(img.width - 1, x0 + 1);
      const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(img.height - 1, y0 + 1);
      const wx = fx - x0, wy = fy - y0;
      let g = 0;
      for (const [xx, yy, wgt] of [[x0, y0, (1 - wx) * (1 - wy)], [x1, y0, wx * (1 - wy)],
                                   [x0, y1, (1 - wx) * wy], [x1, y1, wx * wy]]) {
        const i = (yy * img.width + xx) * 4;
        g += wgt * (0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]);
      }
      out[y * w + x] = g / 255;
    }
  }
  return out;
}

// Returns null (no model) or { label, score, positive }.
function classify(camera, jpegBuf) {
  const model = loadModel(camera);
  if (!model) return null;
  try {
    const img = jpeg.decode(jpegBuf, { useTArray: true, maxMemoryUsageInMB: 64 });
    const g = toGray(img, model.width, model.height, model.subcrop);
    // Optional residual features: per-image standardization (lighting
    // robustness) then subtraction of the stored reference closed scene —
    // must mirror the trainer exactly.
    if (model.per_image_norm) {
      let s = 0; for (let i = 0; i < g.length; i++) s += g[i];
      const m = s / g.length;
      let v = 0; for (let i = 0; i < g.length; i++) v += (g[i] - m) * (g[i] - m);
      const sd = Math.sqrt(v / g.length) + 1e-6;
      for (let i = 0; i < g.length; i++) g[i] = (g[i] - m) / sd;
    }
    // Registration tripwire: correlate the standardized frame with the
    // reference over the right 38% of the crop (the stairs - unaffected by
    // the door state). Correct framing scores >=0.6 whether the door is open
    // or closed; a zoomed/shifted feed (Google silently changed the stream
    // crop on 2026-08-29 and the classifier false-alarmed) scores <=0.32.
    // Automations should trust `positive` only when framingOk is true.
    let refCorr = null;
    if (model.reference && model.per_image_norm) {
      const rx = Math.floor(model.width * 0.62);
      let sa = 0, sb = 0, sab = 0;
      for (let y = 0; y < model.height; y++) {
        for (let x = rx; x < model.width; x++) {
          const i = y * model.width + x;
          const a = g[i], b = model.reference[i];
          sa += a * a; sb += b * b; sab += a * b;
        }
      }
      refCorr = sab / (Math.sqrt(sa * sb) + 1e-9);
    }
    if (model.reference) {
      for (let i = 0; i < g.length; i++) g[i] -= model.reference[i];
    }
    let z = model.bias;
    for (let i = 0; i < g.length; i++) {
      const v = model.std[i] > 1e-6 ? (g[i] - model.mean[i]) / model.std[i] : 0;
      z += v * model.weights[i];
    }
    const score = 1 / (1 + Math.exp(-z));
    const out = { label: model.label, score: Math.round(score * 1000) / 1000, positive: score >= (model.threshold || 0.5) };
    if (refCorr !== null) {
      out.refCorr = Math.round(refCorr * 1000) / 1000;
      out.framingOk = refCorr >= 0.45;
    }
    return out;
  } catch (e) {
    console.warn(`[nest_headless] classify ${camera} failed: ${e.message}`);
    return null;
  }
}

module.exports = { classify };
