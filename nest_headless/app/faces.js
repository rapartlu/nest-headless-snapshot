// Face identity (Hearth #2, second half): SCRFD detection + 5-point alignment
// + ArcFace embedding, on frames from the held streams. Models are hot-loaded
// from <config>/nest_models/identity/models/{scrfd_10g.onnx, arcface_w600k_r50.onnx}
// (InsightFace "buffalo_l": det_10g / w600k_r50). Nothing here decides who a
// person is: it returns embeddings and cosine scores; the brain decides.
'use strict';

const fs = require('fs');
const path = require('path');
const ort = require('onnxruntime-node');
const { decodeJpeg, ORT_OPTS } = require('./infer');

const DET_SIZE = 640, DET_THRESH = 0.5, NMS_THRESH = 0.4, STRIDES = [8, 16, 32], NUM_ANCHORS = 2;
const ALIGN = 112;
// ArcFace 112x112 landmark template (left eye, right eye, nose, mouth left, mouth right)
const ARCFACE_DST = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

let ctx = null; // { det, rec } sessions, or false when the models are absent
async function getSessions(modelsDir) {
  if (ctx !== null) return ctx;
  const det = path.join(modelsDir, 'scrfd_10g.onnx'), rec = path.join(modelsDir, 'arcface_w600k_r50.onnx');
  if (!fs.existsSync(det) || !fs.existsSync(rec)) { ctx = false; return ctx; }
  try {
    const [d, r] = await Promise.all([ort.InferenceSession.create(det, ORT_OPTS), ort.InferenceSession.create(rec, ORT_OPTS)]);
    ctx = { det: d, rec: r };
    console.log('[nest_headless] face models loaded (scrfd_10g + arcface_w600k_r50)');
  } catch (e) { console.warn('[nest_headless] face models failed to load:', e.message); ctx = false; }
  return ctx;
}
function hasModels(modelsDir) { return fs.existsSync(path.join(modelsDir, 'scrfd_10g.onnx')) && fs.existsSync(path.join(modelsDir, 'arcface_w600k_r50.onnx')); }

// SCRFD: letterbox (top-left, scale = min(640/w, 640/h)), (RGB - 127.5) / 128, NCHW.
async function detectFaces(sessions, img) {
  const { data, width: W, height: H } = img;
  const scale = Math.min(DET_SIZE / W, DET_SIZE / H);
  const nw = Math.round(W * scale), nh = Math.round(H * scale);
  const inp = new Float32Array(3 * DET_SIZE * DET_SIZE); // zero padding == black == (0-127.5)/128 after norm? No: pad AFTER norm with 0
  const plane = DET_SIZE * DET_SIZE;
  for (let y = 0; y < nh; y++) {
    const sy = Math.min(H - 1, Math.floor(y / scale));
    for (let x = 0; x < nw; x++) {
      const sx = Math.min(W - 1, Math.floor(x / scale));
      const si = (sy * W + sx) * 4, di = y * DET_SIZE + x;
      inp[di] = (data[si] - 127.5) / 128; inp[plane + di] = (data[si + 1] - 127.5) / 128; inp[2 * plane + di] = (data[si + 2] - 127.5) / 128;
    }
  }
  const out = await sessions.det.run({ [sessions.det.inputNames[0]]: new ort.Tensor('float32', inp, [1, 3, DET_SIZE, DET_SIZE]) });
  const names = sessions.det.outputNames; // scores x3, bboxes x3, kps x3 (per stride)
  const fmc = STRIDES.length;
  const cands = [];
  for (let si = 0; si < fmc; si++) {
    const stride = STRIDES[si];
    const scores = out[names[si]].data, bboxes = out[names[si + fmc]].data, kps = out[names[si + 2 * fmc]].data;
    const gw = DET_SIZE / stride, gh = DET_SIZE / stride;
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) for (let a = 0; a < NUM_ANCHORS; a++) {
      const k = (gy * gw + gx) * NUM_ANCHORS + a;
      const s = scores[k];
      if (s < DET_THRESH) continue;
      const cx = gx * stride, cy = gy * stride;
      const x1 = (cx - bboxes[k * 4] * stride) / scale, y1 = (cy - bboxes[k * 4 + 1] * stride) / scale;
      const x2 = (cx + bboxes[k * 4 + 2] * stride) / scale, y2 = (cy + bboxes[k * 4 + 3] * stride) / scale;
      const pts = [];
      for (let p = 0; p < 5; p++) pts.push([(cx + kps[k * 10 + p * 2] * stride) / scale, (cy + kps[k * 10 + p * 2 + 1] * stride) / scale]);
      cands.push({ score: s, x1, y1, x2, y2, kps: pts });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const c of cands) {
    let ok = true;
    for (const k of keep) {
      const ix = Math.max(0, Math.min(c.x2, k.x2) - Math.max(c.x1, k.x1)), iy = Math.max(0, Math.min(c.y2, k.y2) - Math.max(c.y1, k.y1));
      const inter = ix * iy, u = (c.x2 - c.x1) * (c.y2 - c.y1) + (k.x2 - k.x1) * (k.y2 - k.y1) - inter;
      if (u > 0 && inter / u > NMS_THRESH) { ok = false; break; }
    }
    if (ok) keep.push(c);
  }
  return keep.map((c) => ({
    score: Math.round(c.score * 1000) / 1000,
    box: { x: c.x1 / W, y: c.y1 / H, w: (c.x2 - c.x1) / W, h: (c.y2 - c.y1) / H },
    size_px: Math.round(c.y2 - c.y1),
    kps: c.kps,
  }));
}

// Similarity transform (a, b, tx, ty: x' = a x - b y + tx, y' = b x + a y + ty) by least squares,
// landmarks -> ArcFace template; returns the INVERSE mapping (template -> source) for warping.
function alignMatrix(kps) {
  // normal equations for [a b tx ty]
  const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], B = [0, 0, 0, 0];
  for (let i = 0; i < 5; i++) {
    const [x, y] = kps[i], [u, v] = ARCFACE_DST[i];
    const rows = [[x, -y, 1, 0, u], [y, x, 0, 1, v]];
    for (const r of rows) for (let m = 0; m < 4; m++) { for (let n = 0; n < 4; n++) A[m][n] += r[m] * r[n]; B[m] += r[m] * r[4]; }
  }
  // solve 4x4 by Gaussian elimination
  const M = A.map((row, i) => [...row, B[i]]);
  for (let c = 0; c < 4; c++) {
    let p = c; for (let r = c + 1; r < 4; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = 0; r < 4; r++) { if (r === c) continue; const f = M[r][c] / M[c][c]; for (let k = c; k < 5; k++) M[r][k] -= f * M[c][k]; }
  }
  const a = M[0][4] / M[0][0], b = M[1][4] / M[1][1], tx = M[2][4] / M[2][2], ty = M[3][4] / M[3][3];
  // forward: [a -b tx; b a ty]; inverse of the rotation+scale part
  const det = a * a + b * b; if (det < 1e-12) return null;
  const ia = a / det, ib = -b / det; // inverse rotation/scale matrix [ia -ib; ib ia]
  const itx = -(ia * tx - ib * ty), ity = -(ib * tx + ia * ty);
  return { ia, ib, itx, ity };
}

function alignedCrop(img, kps) {
  const m = alignMatrix(kps);
  if (!m) return null;
  const { data, width: W, height: H } = img;
  const out = new Uint8Array(ALIGN * ALIGN * 3);
  for (let v = 0; v < ALIGN; v++) for (let u = 0; u < ALIGN; u++) {
    const x = m.ia * u - m.ib * v + m.itx, y = m.ib * u + m.ia * v + m.ity;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const o = (v * ALIGN + u) * 3;
    if (x0 < 0 || y0 < 0 || x0 + 1 >= W || y0 + 1 >= H) continue; // border: black
    for (let ch = 0; ch < 3; ch++) {
      const p00 = data[(y0 * W + x0) * 4 + ch], p10 = data[(y0 * W + x0 + 1) * 4 + ch];
      const p01 = data[((y0 + 1) * W + x0) * 4 + ch], p11 = data[((y0 + 1) * W + x0 + 1) * 4 + ch];
      out[o + ch] = (p00 * (1 - fx) + p10 * fx) * (1 - fy) + (p01 * (1 - fx) + p11 * fx) * fy;
    }
  }
  return out;
}

// ArcFace: 112x112 RGB, (x - 127.5) / 127.5, NCHW -> 512-d, L2-normalised.
async function embedAligned(sessions, rgb) {
  const plane = ALIGN * ALIGN, inp = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) { inp[i] = (rgb[i * 3] - 127.5) / 127.5; inp[plane + i] = (rgb[i * 3 + 1] - 127.5) / 127.5; inp[2 * plane + i] = (rgb[i * 3 + 2] - 127.5) / 127.5; }
  const out = await sessions.rec.run({ [sessions.rec.inputNames[0]]: new ort.Tensor('float32', inp, [1, 3, ALIGN, ALIGN]) });
  const e = Array.from(out[sessions.rec.outputNames[0]].data);
  const n = Math.sqrt(e.reduce((a, v) => a + v * v, 0)) || 1;
  return e.map((v) => v / n);
}

// Full pass on a JPEG: faces with embeddings, largest first. minPx: reject tiny faces.
async function facesInJpeg(modelsDir, jpegBuf, { minPx = 60 } = {}) {
  const s = await getSessions(modelsDir);
  if (!s) return null;
  const img = await decodeJpeg(jpegBuf, 96);
  const faces = await detectFaces(s, img);
  const out = [];
  for (const f of faces) {
    const quality = { size_px: f.size_px, det_score: f.score, reason: f.size_px < minPx ? 'face_too_small' : 'ok' };
    let embedding = null, aligned = null;
    if (quality.reason === 'ok') {
      aligned = alignedCrop(img, f.kps);
      if (aligned) embedding = await embedAligned(s, aligned);
    }
    out.push({ box: f.box, score: f.score, quality, embedding, aligned });
  }
  out.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h);
  return out;
}

const cosine = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += a[i] * b[i]; return d; }; // both L2-normalised

module.exports = { hasModels, getSessions, facesInJpeg, cosine, ALIGN };
