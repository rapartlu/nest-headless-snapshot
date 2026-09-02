// Local vision models, in-process via native onnxruntime-node.
//
// Two jobs:
//  - detect(): pretrained YOLO11n (COCO), baked into the image - finds cats
//    and people in a full frame. Used to decide "cat on a kitchen surface"
//    with zero cloud calls.
//  - classifyDoor(): per-camera fine-tuned classifier (open/closed), hot-
//    loaded from the HA config dir like the linear model - retrain and copy,
//    no rebuild.
//
// All preprocessing mirrors ultralytics exactly: detector = letterbox to
// 416 with gray padding; classifier = resize shortest side then center-crop.

'use strict';

const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');
const ort = require('onnxruntime-node');
const os = require('os');
// All cores: the process runs at nice 10 (see server.js getBrowser), so Chromium's
// WebRTC receive path wins contention anyway; a thread cap only slowed detection
// (measured 3.5-4.7 s per /detect on a 2-core NAS with one thread).
// On macOS the CoreML execution provider runs the graphs on the GPU/ANE:
// measured on an M3 Pro, cats 960 67 -> 18 ms, yolo11n 640 25 -> 8 ms, door
// cls 4 -> 1 ms, at the cost of ~1.4 s compilation per session at load
// (sessions are warmed at start-up, see warmUp). Elsewhere: CPU.
const ORT_OPTS = {
  executionProviders: process.platform === 'darwin' && process.env.ORT_COREML !== '0' ? ['coreml', 'cpu'] : ['cpu'],
  intraOpNumThreads: Math.max(1, Math.min(4, os.cpus().length)),
  logSeverityLevel: 3,   // CoreML partition notices are expected; keep the log clean
};

const DET_PATH = path.join(__dirname, 'assets/models/yolo11n.onnx');
// House-trained single-class cat detector (fine-tuned on this kitchen's own
// cats - the pretrained COCO model is nearly blind to them). When the file
// exists it owns cat detection; the COCO model still serves person checks.
const CAT_PATH = path.join(__dirname, 'assets/models/cats.onnx');
const CAT_SIZE = 960;
const DET_SIZE = 640;
const CONF_DEFAULT = 0.35;
const COCO = { 0: 'person', 15: 'cat', 16: 'dog' };
const MODELS_DIRS = [path.join(process.env.HA_CONFIG_DIR || '/homeassistant', 'nest_models'), '/config/nest_models'];

let catSession = null;
async function getCatDetector() {
  if (catSession === null && fs.existsSync(CAT_PATH)) {
    catSession = ort.InferenceSession.create(CAT_PATH, ORT_OPTS)
      .then((s) => { console.log('[nest_headless] house cat detector loaded'); return s; })
      .catch((e) => { console.warn('[nest_headless] cat detector load failed:', e.message); return null; });
  }
  return catSession;
}

let detSession = null;
async function getDetector() {
  if (detSession === null && fs.existsSync(DET_PATH)) {
    detSession = ort.InferenceSession.create(DET_PATH, ORT_OPTS)
      .then((s) => { console.log('[nest_headless] detector loaded (yolo11n)'); return s; })
      .catch((e) => { console.warn('[nest_headless] detector load failed:', e.message); return null; });
  }
  return detSession;
}

const clsCache = {}; // camera -> { session, mtimeMs } | { missing: true }
function clsPath(camera) {
  const name = camera.replace(/^camera\./, '') + '.onnx';
  for (const dir of MODELS_DIRS) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
function hasDoorModel(camera) { return clsPath(camera) !== null; }
async function getCls(camera) {
  const p = clsPath(camera);
  if (!p) { clsCache[camera] = { missing: true }; return null; }
  const st = fs.statSync(p);
  const c = clsCache[camera];
  if (c && c.mtimeMs === st.mtimeMs && c.session) return c.session;
  const session = await ort.InferenceSession.create(p, ORT_OPTS);
  clsCache[camera] = { session, mtimeMs: st.mtimeMs };
  console.log(`[nest_headless] onnx classifier loaded ${p}`);
  return session;
}

// Bilinear sample from decoded RGBA into an RGB CHW Float32Array region.
function resampleInto(img, dst, dstW, dstH, dx0, dy0, dw, dh, sx0, sy0, sw, sh) {
  const plane = dstW * dstH;
  for (let y = 0; y < dh; y++) {
    const fy = sy0 + ((y + 0.5) / dh) * sh - 0.5;
    const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(img.height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = sx0 + ((x + 0.5) / dw) * sw - 0.5;
      const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(img.width - 1, x0 + 1);
      const wx = fx - x0;
      let r = 0, g = 0, b = 0;
      for (const [xx, yy, wgt] of [[x0, y0, (1 - wx) * (1 - wy)], [x1, y0, wx * (1 - wy)],
                                   [x0, y1, (1 - wx) * wy], [x1, y1, wx * wy]]) {
        const i = (yy * img.width + xx) * 4;
        r += wgt * img.data[i]; g += wgt * img.data[i + 1]; b += wgt * img.data[i + 2];
      }
      const di = (dy0 + y) * dstW + (dx0 + x);
      dst[di] = r / 255; dst[plane + di] = g / 255; dst[2 * plane + di] = b / 255;
    }
  }
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter + 1e-9);
}

// JPEG -> RGBA off the event loop. jpeg-js decodes a 1080p frame in ~90 ms of
// main-thread JavaScript, which is the only part of a detection that blocks
// anything (onnxruntime already runs on its own threads); sharp (libvips) does
// it natively in a worker in ~10 ms. Same {data, width, height} shape.
let sharpMod = null;
function getSharp() {
  if (sharpMod === null) { try { sharpMod = require('sharp'); } catch (e) { sharpMod = false; console.warn('[nest_headless] sharp unavailable, decoding JPEG in JS:', e.message); } }
  return sharpMod;
}
async function decodeJpeg(jpegBuf, maxMB = 96) {
  const sharp = getSharp();
  if (sharp) {
    const { data, info } = await sharp(jpegBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  }
  return jpeg.decode(jpegBuf, { useTArray: true, maxMemoryUsageInMB: maxMB });
}

// Load (and on CoreML, compile) the sessions at start-up so the first live
// detection does not pay ~1.4 s per model.
async function warmUp() {
  const t = Date.now();
  await Promise.all([getCatDetector(), getDetector()]);
  return Date.now() - t;
}

// Detect objects in a JPEG buffer. Returns [{cls, name, conf, box:{x,y,w,h}}]
// with box coords as fractions of the frame.
// `region` ({x,y,w,h} fractions) restricts detection to a zoomed sub-view -
// essential for small/distant animals that vanish at full-frame scale.
// Returned boxes are always in FULL-frame fractions regardless of region.
async function detect(jpegBuf, { conf = CONF_DEFAULT, classes = null, region = null, session = null, size = null, clsMap = null } = {}) {
  session = session || await getDetector();
  if (!session) return null;
  const DS = size || DET_SIZE;
  const img = await decodeJpeg(jpegBuf, 96);
  const rx = region ? Math.max(0, region.x) * img.width : 0;
  const ry = region ? Math.max(0, region.y) * img.height : 0;
  const rw = region ? Math.min(1 - Math.max(0, region.x), region.w) * img.width : img.width;
  const rh = region ? Math.min(1 - Math.max(0, region.y), region.h) * img.height : img.height;
  // letterbox: scale the (sub)view to fit DET_SIZE, pad with 0.5 gray
  const scale = Math.min(DS / rw, DS / rh);
  const dw = Math.round(rw * scale), dh = Math.round(rh * scale);
  const px = Math.floor((DS - dw) / 2), py = Math.floor((DS - dh) / 2);
  const data = new Float32Array(3 * DS * DS).fill(0.5);
  resampleInto(img, data, DS, DS, px, py, dw, dh, rx, ry, rw, rh);
  const out = await session.run({ images: new ort.Tensor('float32', data, [1, 3, DS, DS]) });
  const t = out[Object.keys(out)[0]]; // [1, 84, N]
  const [, C, N] = t.dims;
  const d = t.data;
  const cand = [];
  for (let i = 0; i < N; i++) {
    let best = 0, bc = -1;
    for (let c = 4; c < C; c++) {
      const v = d[c * N + i];
      if (v > best) { best = v; bc = c - 4; }
    }
    if (best < conf) continue;
    if (classes && !classes.includes(bc)) continue;
    const cx = d[i], cy = d[N + i], w = d[2 * N + i], h = d[3 * N + i];
    const mc = clsMap ? clsMap(bc) : bc;
    cand.push({
      cls: mc, name: COCO[mc] || 'cls' + mc, conf: Math.round(best * 1000) / 1000,
      box: {
        x: (rx + (cx - w / 2 - px) / scale) / img.width,
        y: (ry + (cy - h / 2 - py) / scale) / img.height,
        w: w / scale / img.width,
        h: h / scale / img.height,
      },
    });
  }
  cand.sort((a, b) => b.conf - a.conf);
  const keep = [];
  for (const c of cand) {
    if (keep.every((k) => k.cls !== c.cls || iou(k.box, c.box) < 0.5)) keep.push(c);
    if (keep.length >= 12) break;
  }
  return keep;
}

// Classify a door-zone crop JPEG with the camera's fine-tuned model.
// Returns { label, score, positive } or null when no model / failure.
// Threshold 0.30: the v11 laser-slice CNN scores closed at 0.00-0.03 and
// settled opens 0.98+, but in-between door ANGLES (live test 2026-09-01,
// Paul: "i opened it to see if you'd catch it") sit at 0.5-0.8 and flapped
// across the old 0.6 line - the persistence gate then never fired. 0.30
// keeps 10x margin over closed while making every open angle a solid tick
// ways - and catches barely-ajar states a 0.9 threshold would miss.
async function classifyDoor(camera, jpegBuf, { size = 256, threshold = 0.30, label = 'door_open' } = {}) {
  const session = await getCls(camera);
  if (!session) return null;
  const img = await decodeJpeg(jpegBuf, 64);
  // ultralytics classify eval: resize shortest side to `size`, center crop
  const s = size / Math.min(img.width, img.height);
  const rw = img.width * s, rh = img.height * s;
  const cx = (rw - size) / 2 / s, cy = (rh - size) / 2 / s; // crop origin in source px
  const data = new Float32Array(3 * size * size);
  resampleInto(img, data, size, size, 0, 0, size, size, cx, cy, size / s, size / s);
  const out = await session.run({ images: new ort.Tensor('float32', data, [1, 3, size, size]) });
  const t = out[Object.keys(out)[0]].data; // [1,2] - {0: closed, 1: open} (alphabetical)
  let p0 = t[0], p1 = t[1];
  const sum = p0 + p1;
  if (!(sum > 0.99 && sum < 1.01)) { // logits -> softmax
    const m = Math.max(p0, p1);
    const e0 = Math.exp(p0 - m), e1 = Math.exp(p1 - m);
    p0 = e0 / (e0 + e1); p1 = e1 / (e0 + e1);
  }
  const score = Math.round(p1 * 1000) / 1000;
  return { label, score, positive: score >= threshold, engine: 'onnx' };
}

// Burn detection boxes (and the watched regions) into a JPEG - pure JS via
// jpeg-js, no canvas. Answers "where exactly was the cat?" in the alert
// notification itself instead of leaving it to archaeology.
function annotate(jpegBuf, dets, rois = [], { quality = 85 } = {}) {
  const img = jpeg.decode(jpegBuf, { useTArray: true, maxMemoryUsageInMB: 96 });
  const W = img.width, H = img.height, d = img.data;
  const px = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b;
  };
  const rect = (bx, by, bw, bh, r, g, b, t) => {
    const x0 = Math.round(bx * W), y0 = Math.round(by * H);
    const x1 = Math.round((bx + bw) * W), y1 = Math.round((by + bh) * H);
    for (let k = 0; k < t; k++) {
      for (let x = x0; x <= x1; x++) { px(x, y0 + k, r, g, b); px(x, y1 - k, r, g, b); }
      for (let y = y0; y <= y1; y++) { px(x0 + k, y, r, g, b); px(x1 - k, y, r, g, b); }
    }
  };
  const line = (xa, ya, xb, yb, r, g, b, t) => {
    const steps = Math.max(Math.abs(xb - xa), Math.abs(yb - ya)) | 0;
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(xa + (xb - xa) * i / (steps || 1));
      const y = Math.round(ya + (yb - ya) * i / (steps || 1));
      for (let k = -((t / 2) | 0); k <= (t / 2) | 0; k++) { px(x + k, y, r, g, b); px(x, y + k, r, g, b); }
    }
  };
  for (const r of rois) {
    if (r.pts) {                                    // polygon zone
      for (let i = 0; i < r.pts.length; i++) {
        const a = r.pts[i], b2 = r.pts[(i + 1) % r.pts.length];
        line(a[0] * W, a[1] * H, b2[0] * W, b2[1] * H, 255, 210, 0, 3);
      }
    } else rect(r.x, r.y, r.w, r.h, 255, 210, 0, 2); // legacy rect zone
  }
  for (const x of dets || []) {
    const animal = x.cls === 15 || x.cls === 16;
    rect(x.box.x, x.box.y, x.box.w, x.box.h, animal ? 255 : 90, animal ? 40 : 200, animal ? 60 : 255, animal ? 6 : 3);
  }
  return jpeg.encode({ data: d, width: W, height: H }, quality).data;
}

// Cat detection via the house-trained model when available, COCO otherwise.
// COCO classes that small household objects on surfaces get detected as.
// Used to veto house-model cat calls: the fine-tuned single-class model is
// sharp on THIS house's cats but treats any novel compact object as
// cat-until-proven-otherwise (wipes tub 0.71, saucepan 0.20, a head 0.42).
// Stock COCO knows what those objects ARE - so if it sees a container-ish
// object in the same spot and no cat, the default knowledge wins.
const OBJECT_CLASSES = [39, 40, 41, 45, 58, 75]; // bottle, wine glass, cup, bowl, potted plant, vase

async function detectCats(jpegBuf, opts = {}) {
  const house = await getCatDetector();
  // note: no classes filter here - the house model is single-class (cat=0)
  // and the filter would run on the RAW index before clsMap renames it
  if (!house) return detect(jpegBuf, { ...opts, classes: [15, 16] });
  const dets = await detect(jpegBuf, { ...opts, session: house, size: CAT_SIZE, classes: null, clsMap: () => 15 });
  if (!dets || !dets.length) return dets;
  // Cross-examine each house call with the stock COCO model on the same view
  const ref = await detect(jpegBuf, { ...opts, conf: 0.25, classes: [15, 16, ...OBJECT_CLASSES] });
  if (ref === null) return dets;
  const iou = (a, b) => {
    const x1 = Math.max(a.box.x, b.box.x), y1 = Math.max(a.box.y, b.box.y);
    const x2 = Math.min(a.box.x + a.box.w, b.box.x + b.box.w);
    const y2 = Math.min(a.box.y + a.box.h, b.box.y + b.box.h);
    const i = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return i / (a.box.w * a.box.h + b.box.w * b.box.h - i + 1e-9);
  };
  return dets.filter((d) => {
    const obj = ref.find((r) => OBJECT_CLASSES.includes(r.cls) && iou(d, r) > 0.3);
    const cocoCat = ref.find((r) => (r.cls === 15 || r.cls === 16) && iou(d, r) > 0.3);
    if (obj && !cocoCat) {
      console.log(`[nest_headless] veto: house cat:${d.conf} is a ${obj.name}:${obj.conf} per COCO`);
      return false;
    }
    return true;
  });
}

module.exports = { detect, detectCats, classifyDoor, hasDoorModel, annotate, warmUp };
