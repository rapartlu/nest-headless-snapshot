#!/usr/bin/env node
// nest_headless — server-side Nest camera stills via headless Chromium.
//
// Home Assistant relays WebRTC-only Nest cameras' live stream to the browser
// but never terminates the media itself, so camera.snapshot has no frame to
// return and hands back a placeholder. This add-on runs a real browser
// (headless Chromium) that opens the stream the same way the dashboard does,
// waits for it to ramp to full resolution, and turns a decoded frame into a
// JPEG. Watch mode holds the stream open for instant frames and local
// on-surface motion / classifier checks.
//
// HTTP API (mirrors the nest_snapshot add-on so automations keep their shape):
//   GET /snapshot/<camera>          capture now (or cached if younger than
//                                   min_interval_seconds), return JPEG
//   GET /latest/<camera>.jpg        serve last captured file, 404 if none
//   GET /health                     liveness
//   GET /                           status JSON
//
// Files are written atomically to <out_dir>/<camera>.jpg for use with
// llmvision.image_analyzer's image_file. Response headers carry
// X-Capture-Age-Seconds and X-Mean-Luma so callers can add freshness and
// black-frame guards.
//
// Home Assistant access: SUPERVISOR_TOKEN + ws://supervisor/core/websocket
// (standard add-on API proxy; requires homeassistant_api: true).

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const puppeteer = require('puppeteer-core');
const fns = require('./pagefns');
const { classify } = require('./classifier');
const infer = require('./infer');

// ------------------------------------------------------------ configuration
const cfg = {
  port: intEnv('PORT', 8098),
  minIntervalSeconds: intEnv('MIN_INTERVAL_SECONDS', 10),
  jpegQuality: intEnv('JPEG_QUALITY', 85) / 100,
  captureTimeoutSeconds: intEnv('CAPTURE_TIMEOUT_SECONDS', 25),
  warmupFrames: intEnv('WARMUP_FRAMES', 3),
  // supervisor mounts HA config at /homeassistant (homeassistant_config map)
  // or /config (legacy map) depending on base/supervisor version
  outDir: process.env.OUT_DIR ||
    (fs.existsSync('/homeassistant') ? '/homeassistant/www/nest' : '/config/www/nest'),
  chromiumPath: process.env.CHROMIUM_PATH || firstExisting(
    ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'], true),
  haWsUrl: process.env.HA_WS_URL || 'ws://supervisor/core/websocket',
  haToken: process.env.SUPERVISOR_TOKEN || process.env.HA_TOKEN || '',
  // Fixed regions of interest, e.g. "downstairs_hallway_camera:0.22:0.0:0.30:0.62"
  // (space-separated entries; x:y:w:h as fractions of the frame). Each capture
  // also writes <camera>_crop.jpg for that region — a stable close-up that
  // makes small state changes trivial for vision models.
  crops: parseCrops(process.env.CROPS || ''),
  // When set, every capture also archives its crop as
  // <samplesDir>/<camera>/<timestamp>.jpg (capped) — training data for the
  // tiny door-state classifier, gathered across lighting conditions.
  samplesDir: process.env.SAMPLES_DIR || '',
  samplesMax: intEnv('SAMPLES_MAX', 2000),
  // Archive cadence: at most one frame per this many seconds reaches the
  // samples dir / timeline, and watched cameras also heartbeat-archive at
  // this rate even with zero motion (frames come off the live stream, so a
  // denser cadence costs disk, not Google API quota).
  sampleArchiveSeconds: intEnv('SAMPLE_ARCHIVE_SECONDS', 120),
  // Persistent watch mode: hold one stream open per listed camera and sample
  // it locally. "camera:interval_seconds" entries, space-separated.
  // No per-check SDM command; HA keeps extending the Google session.
  watches: parseWatches(process.env.WATCHES || ''),
  // Surface regions to diff, per camera:
  //   "kitchen_camera:table@0.26:0.55:0.62:0.43;island@0.30:0.32:0.22:0.12"
  // (name@x:y:w:h as fractions, boxes ';'-separated, cameras space-separated)
  watchRois: parseWatchRois(process.env.WATCH_ROIS || ''),
  watchDiffPct: Number(process.env.WATCH_DIFF_PCT || 4),
  watchCooldownSeconds: intEnv('WATCH_COOLDOWN_SECONDS', 60),
  // For watched cameras with a crop + trained model: score the live stream
  // every N seconds and fire nest_headless_classifier_positive on a positive
  // verdict (with framing gate respected). 0 disables.
  watchClassifySeconds: intEnv('WATCH_CLASSIFY_SECONDS', 15),
  // A "left open" state is persistent; hallway traffic and lighting flips are
  // not. Require this many consecutive tick-window samples with >=85%
  // positives (and the last 3 all positive) before the event fires.
  // 16 ticks at 15 s = a solid 4 minutes of evidence. 0 or 1 = fire at once.
  watchClassifyPersistTicks: intEnv('WATCH_CLASSIFY_PERSIST_TICKS', 16),
};

function parseWatches(spec) {
  const out = {};
  for (const entry of spec.split(/\s+/).filter(Boolean)) {
    const i = entry.lastIndexOf(':');
    if (i < 0) { out['camera.' + entry] = 4; continue; }
    out['camera.' + entry.slice(0, i)] = Math.max(1, Number(entry.slice(i + 1)) || 4);
  }
  return out;
}

function parseWatchRois(spec) {
  const out = {};
  for (const entry of spec.split(/\s+/).filter(Boolean)) {
    const ci = entry.indexOf(':');
    if (ci < 0) continue;
    const cam = 'camera.' + entry.slice(0, ci);
    out[cam] = entry.slice(ci + 1).split(';').map((box, i) => {
      let name = 'roi' + (i + 1), rest = box;
      const at = box.indexOf('@');
      if (at > 0) { name = box.slice(0, at); rest = box.slice(at + 1); }
      const [x, y, w, h] = rest.split(':').map(Number);
      return { name, x, y, w, h };
    }).filter((r) => r.w > 0 && r.h > 0);
  }
  return out;
}

function parseCrops(spec) {
  const out = {};
  for (const entry of spec.trim().split(/\s+/).filter(Boolean)) {
    const [name, x, y, w, h] = entry.split(':');
    const vals = [x, y, w, h].map(Number);
    if (name && vals.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) {
      out['camera.' + name.replace(/^camera\./, '')] = { x: vals[0], y: vals[1], w: vals[2], h: vals[3] };
    }
  }
  return out;
}

function intEnv(name, dflt) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) ? v : dflt;
}
function firstExisting(paths, isFile) {
  for (const p of paths) {
    try {
      if (isFile ? fs.existsSync(p) : fs.existsSync(path.dirname(p))) return p;
    } catch (e) { /* keep looking */ }
  }
  return paths[0];
}

if (!cfg.haToken) {
  console.error('FATAL: no SUPERVISOR_TOKEN / HA_TOKEN available');
  process.exit(1);
}
fs.mkdirSync(cfg.outDir, { recursive: true });
console.log('[nest_headless] config:', JSON.stringify({ ...cfg, haToken: '<set>' }));

// ------------------------------------------------------------ Google SDP quirk
// Google's answer emits "a=candidate: " with an EMPTY foundation (6/6
// candidates on these cameras). Chrome tolerates it, but patch anyway —
// proven form from the working browser control.
const patchFoundation = (sdp) => sdp.replace(/a=candidate: /g, 'a=candidate:0 ');
const patchCandidate = (c) => (typeof c === 'string' ? c.replace(/^candidate: /, 'candidate:0 ') : c);

// ------------------------------------------------------------ HA websocket
function haOfferSession(entityId, offerSdp, { onAnswer, onCandidate, onError }) {
  // Returns { close } — closing the socket ends the HA-side session.
  const ws = new WebSocket(cfg.haWsUrl);
  let msgId = 0;
  let subId = null;
  let closed = false;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.type === 'auth_required') {
      ws.send(JSON.stringify({ type: 'auth', access_token: cfg.haToken }));
    } else if (m.type === 'auth_ok') {
      subId = ++msgId;
      ws.send(JSON.stringify({
        id: subId, type: 'camera/webrtc/offer', entity_id: entityId, offer: offerSdp,
      }));
    } else if (m.type === 'auth_invalid') {
      onError(new Error('HA websocket auth failed'));
    } else if (m.type === 'result' && m.id === subId && m.success === false) {
      onError(new Error('HA rejected offer: ' + JSON.stringify(m.error)));
    } else if (m.type === 'event' && m.id === subId && m.event) {
      const ev = m.event;
      if (ev.type === 'answer') onAnswer(ev.answer);
      else if (ev.type === 'candidate') onCandidate(ev.candidate);
      else if (ev.type === 'error') onError(new Error(`HA webrtc error: ${ev.code} ${ev.message}`));
    }
  });
  ws.on('error', (e) => onError(e));
  ws.on('close', () => { closed = true; });
  return { close: () => { if (!closed) try { ws.close(); } catch (e) { /* ok */ } } };
}

// ------------------------------------------------------------ browser
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      executablePath: cfg.chromiumPath,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--autoplay-policy=no-user-gesture-required',
        '--no-first-run',
        '--disable-extensions',
        '--mute-audio',
      ],
    }).then(async (b) => {
      b.on('disconnected', () => { browserPromise = null; });
      // log codec support once — H.264 must be present for Nest
      const p = await b.newPage();
      const codecs = await p.evaluate(fns.videoCodecs);
      console.log('[nest_headless] receiver video codecs:', codecs.join(', '));
      if (!codecs.some((c) => /h264/i.test(c))) {
        console.error('[nest_headless] WARNING: this Chromium build lacks H.264 — Nest video will not decode');
      }
      await p.close();
      return b;
    });
  }
  return browserPromise;
}

// ------------------------------------------------------------ capture
const state = {}; // per-camera: { lastCaptureMs, inflight: Promise|null, lastMeta }

function cameraEntity(name) {
  return name.startsWith('camera.') ? name : `camera.${name}`;
}
function cameraFile(name) {
  return path.join(cfg.outDir, name.replace(/^camera\./, '') + '.jpg');
}

// Offer/answer/candidates over the HA websocket for one page. Shared by the
// one-shot capture path and the persistent watch path.
async function dialSession(entityId, page, timeoutMs) {
  const offerSdp = await page.evaluate(fns.initPeer);
  let session = null;
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('no answer from HA within timeout')), timeoutMs);
    session = haOfferSession(entityId, offerSdp, {
      onAnswer: async (sdp) => {
        clearTimeout(to);
        try {
          await page.evaluate(fns.setRemoteAnswer, patchFoundation(sdp));
          resolve();
        } catch (e) { reject(e); }
      },
      onCandidate: async (cand) => {
        const c = (cand && typeof cand === 'object')
          ? { ...cand, candidate: patchCandidate(cand.candidate) }
          : { candidate: patchCandidate(cand) };
        try { await page.evaluate(fns.addRemoteCandidate, c); } catch (e) { /* page may be gone */ }
      },
      onError: (e) => { clearTimeout(to); reject(e); },
    });
  });
  return session;
}

async function capture(entityId) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  let session = null;
  const timeoutMs = cfg.captureTimeoutSeconds * 1000;
  try {
    await page.goto('about:blank');
    session = await dialSession(entityId, page, timeoutMs);

    const shot = await page.evaluate(fns.waitAndCapture, {
      warmupFrames: cfg.warmupFrames,
      quality: cfg.jpegQuality,
      timeoutMs,
      crop: cfg.crops[entityId] || null,
    });
    return persistShot(entityId, shot);
  } finally {
    if (session) session.close(); // ends the HA/Google session -> frees quota slot
    try { await page.close(); } catch (e) { /* ok */ }
  }
}

// Write the frame (and crop) to disk, run the classifier, build capture meta.
async function persistShot(entityId, shot) {
  const buf = Buffer.from(shot.dataUrl.split(',')[1], 'base64');
    const file = cameraFile(entityId);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
    let cropFile = null;
    let verdict = null;
    if (shot.cropDataUrl) {
      cropFile = file.replace(/\.jpg$/, '_crop.jpg');
      const cbuf = Buffer.from(shot.cropDataUrl.split(',')[1], 'base64');
      fs.writeFileSync(cropFile + '.tmp', cbuf);
      fs.renameSync(cropFile + '.tmp', cropFile);
      verdict = classify(entityId, cbuf); // linear model: verdict + framing gate
      // The fine-tuned CNN (hot-loaded onnx) outranks the linear verdict when
      // present; the linear model's framing gate still applies on top.
      if (infer.hasDoorModel(entityId)) {
        const cnn = await infer.classifyDoor(entityId, cbuf).catch((e) => {
          console.warn(`[nest_headless] onnx classify ${entityId} failed: ${e.message}`); return null;
        });
        if (cnn) {
          const framingOk = verdict ? verdict.framingOk : undefined;
          verdict = {
            ...cnn,
            ...(verdict && verdict.refCorr !== undefined ? { refCorr: verdict.refCorr, framingOk } : {}),
            // The CNN's verdict stands on its own: a WIDE-open door occludes
            // the reference region and tanks refCorr, so the framing veto
            // muted the exact state this classifier exists to catch (score
            // 1.00 suppressed for over an hour on 2026-08-31). refCorr stays
            // in the meta as a camera-moved telltale for humans; only the
            // linear engine still needs the gate.
            positive: cnn.positive,
          };
        }
      }
    }
    const meta = {
      file, cropFile, bytes: buf.length, width: shot.width, height: shot.height,
      frames: shot.frames, meanLuma: Math.round(shot.meanLuma * 10) / 10,
      capturedAt: new Date().toISOString(),
      ...(verdict ? { classifier: verdict } : {}),
    };
  console.log(`[nest_headless] captured ${entityId}:`, JSON.stringify(meta));
  if (shot.meanLuma < 3) {
    console.warn(`[nest_headless] WARNING: ${entityId} frame is near-black (meanLuma ${shot.meanLuma})`);
  }
  if (cfg.samplesDir) {
    const stamped = archiveSample(entityId, cropFile ? Buffer.from(shot.cropDataUrl.split(',')[1], 'base64') : buf);
    if (stamped) {
      if (cropFile) {
        // cropped camera: the crop is the timeline image, but keep the full
        // frame too (as *_f.jpg) - crops cover only the door, so floor-level
        // animals were never being archived and the detector had no hallway
        // training data at all
        try {
          fs.writeFileSync(path.join(cfg.samplesDir, entityId.replace(/^camera\./, ''),
            stamped.replace(/\.jpg$/, '_f.jpg')), buf);
        } catch (e) { /* crop archive still stands */ }
      }
      const entry = { t: new Date().toISOString(), img: stamped, luma: meta.meanLuma };
      if (verdict) entry.classifier = verdict;
      if (!cropFile) {
        // full-frame camera: enrich the timeline with detections + boxes
        try {
          const { cat, dets } = await catOnSurface(entityId, buf);
          entry.cat = cat;
          entry.dets = (dets || []).map((d) => ({ name: d.name, conf: d.conf, roi: d.roi }));
          const boxed = infer.annotate(buf, dets || [], cfg.watchRois[entityId] || []);
          const aname = stamped.replace(/\.jpg$/, '_a.jpg');
          fs.writeFileSync(path.join(cfg.samplesDir, entityId.replace(/^camera\./, ''), aname), boxed);
          entry.aimg = aname;
        } catch (e) { /* timeline entry stays un-annotated */ }
      }
      appendTimeline(entityId, entry);
    }
  }
  return { buf, meta };
}

const lastArchiveMs = {};
function archiveSample(entityId, buf) {
  try {
    // keep the training archive at a sane cadence however often frames flow
    const now = Date.now();
    if (now - (lastArchiveMs[entityId] || 0) < cfg.sampleArchiveSeconds * 1000 - 2000) return null;
    lastArchiveMs[entityId] = now;
    const dir = path.join(cfg.samplesDir, entityId.replace(/^camera\./, ''));
    fs.mkdirSync(dir, { recursive: true });
    const existing = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
    // cap the archive: drop oldest tenth when full
    if (existing.length >= cfg.samplesMax) {
      for (const f of existing.slice(0, Math.ceil(cfg.samplesMax / 10))) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* ok */ }
      }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(dir, stamp + '.jpg'), buf);
    return stamp + '.jpg';
  } catch (e) {
    console.warn('[nest_headless] sample archive failed:', e.message);
    return null;
  }
}

// Rolling per-camera capture timeline: samples/<camera>/timeline.json holds
// the newest 300 archived captures with their verdicts/detections, and the
// dashboard card renders it. Served by HA from /local (the samples dir lives
// under www/).
const timelineCache = {};
function appendTimeline(entityId, entry) {
  try {
    const cam = entityId.replace(/^camera\./, '');
    const dir = path.join(cfg.samplesDir, cam);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'timeline.json');
    let arr = timelineCache[cam];
    if (!arr) { try { arr = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { arr = []; } }
    arr.unshift(entry);
    if (arr.length > 300) arr = arr.slice(0, 300);
    timelineCache[cam] = arr;
    fs.writeFileSync(f + '.tmp', JSON.stringify(arr));
    fs.renameSync(f + '.tmp', f);
  } catch (e) {
    console.warn('[nest_headless] timeline append failed:', e.message);
  }
}

async function captureCoalesced(entityId) {
  const s = state[entityId] || (state[entityId] = { lastCaptureMs: 0, inflight: null, lastMeta: null });
  if (s.inflight) return s.inflight; // coalesce concurrent requests: one Google command
  s.inflight = (async () => {
    // Fast path: a live watch stream serves frames instantly, no new dial,
    // no SDM command. Falls back to a one-shot dial if the grab fails.
    const w = await watchGrab(entityId).catch(() => null);
    return w || capture(entityId);
  })()
    .then((r) => { s.lastCaptureMs = Date.now(); s.lastMeta = r.meta; return r; })
    .finally(() => { s.inflight = null; });
  return s.inflight;
}

// ------------------------------------------------------------ watch mode
const watchMgr = {}; // entityId -> { page, ready, hits, lastHitMs, startedAt, lastError }

async function watchGrab(entityId) {
  const mgr = watchMgr[entityId];
  if (!mgr || !mgr.ready || !mgr.page) return null;
  const shot = await mgr.page.evaluate(fns.grabFrame, {
    quality: cfg.jpegQuality,
    crop: cfg.crops[entityId] || null,
  });
  if (cfg.samplesDir && shot.cropDataUrl) {
    // keep the training archive flowing on the fast path too
  }
  return persistShot(entityId, shot);
}

function postHaEvent(type, data) {
  return new Promise((resolve) => {
    try {
      const u = new URL(cfg.haWsUrl.replace(/^ws/, 'http'));
      const prefix = u.hostname === 'supervisor' ? '/core/api/events/' : '/api/events/';
      const req = http.request({
        host: u.hostname, port: u.port || 80, path: prefix + type, method: 'POST',
        headers: { Authorization: 'Bearer ' + cfg.haToken, 'Content-Type': 'application/json' },
      }, (r) => { r.resume(); resolve(r.statusCode); });
      req.on('error', (e) => { console.warn('[nest_headless] HA event failed:', e.message); resolve(0); });
      req.end(JSON.stringify(data));
    } catch (e) { resolve(0); }
  });
}

async function watchHit(entityId, payload) {
  const mgr = watchMgr[entityId];
  if (!mgr) return;
  const now = Date.now();
  // Stream-settle grace: a freshly (re)connected stream shifts exposure and
  // resolution for its first seconds, which diffs like motion (fired a
  // phantom deterrent 6s after a restart). Ignore hits until it settles.
  if (now - (mgr.readySinceMs || 0) < 45000) return;
  if (now - mgr.lastHitMs < cfg.watchCooldownSeconds * 1000) return;
  mgr.lastHitMs = now;
  mgr.hits = (mgr.hits || 0) + 1;
  if (payload.meanLuma < 3) return; // black frame, nothing to see
  await persistShot(entityId, payload);
  const st = state[entityId] || (state[entityId] = { lastCaptureMs: 0, inflight: null, lastMeta: null });
  st.lastCaptureMs = now;
  // Local detector decides whether this is worth anyone's attention: the
  // event only fires when a cat (or dog) is actually ON a watched surface.
  // People trigger the same pixel diff constantly; they are logged, not fired.
  const frameBuf = Buffer.from(payload.dataUrl.split(',')[1], 'base64');
  const { cat, dets } = await catOnSurface(entityId, frameBuf);
  // Verdict comes from the detector alone. The "suspected" motion heuristic
  // shipped and was retired the same night: 3 firings, 0 cats (person-exit
  // wake, stream settle, lamp shimmer). The house-trained model replaces it.
  const verdict = cat;
  console.log(`[nest_headless] watch hit ${entityId} roi=${payload.roi} changed=${payload.changedPct}% cat=${verdict} dets=${dets ? dets.map((x) => x.name + ':' + x.conf).join(',') : 'n/a'}`);
  if (verdict === false) return;
  await postHaEvent('nest_headless_surface_activity', {
    entity_id: entityId,
    camera: entityId.replace(/^camera\./, ''),
    roi: payload.roi,
    changed_pct: payload.changedPct,
    cat: verdict,
    detections: dets ? dets.slice(0, 5) : null,
  });
}

// Keep the evidence: raw + box-annotated copies of every frame that
// confirmed a cat on a surface. The alert notification shows the annotated
// one, so "where was it?" never needs forensics again.
function saveCatSnapshot(entityId, frameBuf, dets) {
  try {
    const base = cameraFile(entityId).replace(/\.jpg$/, '');
    fs.writeFileSync(base + '_cat_raw.jpg', frameBuf);
    const boxed = infer.annotate(frameBuf, dets, cfg.watchRois[entityId] || []);
    fs.writeFileSync(base + '_cat.jpg', boxed);
    if (cfg.samplesDir) {
      // every cat event archived, no throttle: these are the frames questions
      // get asked about ("where was it? was that really a cat?")
      const dir = path.join(cfg.samplesDir, entityId.replace(/^camera\./, '') + '_cats');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, new Date().toISOString().replace(/[:.]/g, '-') + '.jpg'), boxed);
    }
  } catch (e) {
    console.warn(`[nest_headless] cat snapshot ${entityId} failed: ${e.message}`);
  }
}

// Is a cat (or dog) standing on one of this camera's watched surfaces?
// Uses the box's bottom-centre - the animal's feet - for ROI membership.
// Returns { cat: true/false/null, dets } - null when the detector is
// unavailable (callers should treat that as "unknown", not "no").
async function catOnSurface(entityId, frameBuf) {
  try {
    const rois = cfg.watchRois[entityId] || [];
    if (!rois.length) return { cat: null, dets: null };
    const dets = [];
    let ran = false;
    let cat = false;
    for (const r of rois) {
      // Detect inside a ZOOMED view of each surface: distant animals vanish
      // at full-frame scale (a far cat is ~13px - proven blind spot), but at
      // ROI zoom the same cat detects at 0.8 conf. The ROI marks where feet
      // land; the body rises above it, so pad upward and sideways.
      const region = {
        x: Math.max(0, r.x - 0.08), y: Math.max(0, r.y - 0.22),
        w: Math.min(1, r.w + 0.16), h: Math.min(1, r.h + 0.28),
      };
      const d = await infer.detectCats(frameBuf, { conf: 0.5, region });
      if (d === null) continue;
      ran = true;
      for (const x of d) {
        dets.push({ ...x, roi: r.name });
        if (x.cls === 15 || x.cls === 16) {
          // placement: the animal's feet (box bottom-centre, full-frame
          // coords) must be on the surface itself, not the floor behind it
          const fx = x.box.x + x.box.w / 2, fy = x.box.y + x.box.h;
          if (fx >= r.x && fx <= r.x + r.w && fy >= r.y - 0.02 && fy <= r.y + r.h + 0.04) cat = true;
        }
      }
    }
    if (!ran) return { cat: null, dets: null };
    if (cat) saveCatSnapshot(entityId, frameBuf, dets);
    return { cat, dets };
  } catch (e) {
    console.warn(`[nest_headless] detect ${entityId} failed: ${e.message}`);
    return { cat: null, dets: null };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runWatch(entityId, intervalSec) {
  const mgr = watchMgr[entityId] = { ready: false, hits: 0, lastHitMs: 0, lastError: null, page: null };
  const rois = cfg.watchRois[entityId] || [];
  // No ROIs is fine: the stream still serves instant snapshots and classify
  // ticks - there is just no surface-motion event source for this camera.
  for (;;) {
    let page = null, session = null, classifyTimer = null, heartbeatTimer = null;
    try {
      const browser = await getBrowser();
      page = await browser.newPage();
      await page.goto('about:blank');
      await page.exposeFunction('__watchHitNode', (payload) =>
        watchHit(entityId, payload).catch((e) => console.warn('[nest_headless] watch hit failed:', e.message)));
      session = await dialSession(entityId, page, cfg.captureTimeoutSeconds * 1000);
      const dims = await page.evaluate(fns.startWatchVideo, {
        timeoutMs: cfg.captureTimeoutSeconds * 1000, warmupFrames: cfg.warmupFrames,
      });
      if (rois.length) {
        // install grabFrame into the page's global scope first - evaluated
        // functions lose their module closures (see note in pagefns)
        await page.evaluate((src) => { window.__grabFrame = eval('(' + src + ')'); }, fns.grabFrame.toString());
        await page.evaluate(fns.startWatchLoop, {
          intervalMs: intervalSec * 1000, rois, diffPct: cfg.watchDiffPct, quality: cfg.jpegQuality,
        });
      }
      mgr.page = page; mgr.ready = true; mgr.startedAt = new Date().toISOString(); mgr.lastError = null;
      mgr.readySinceMs = Date.now();
      mgr.lastPersonMs = Date.now(); // cold start: assume people were just about
      console.log(`[nest_headless] watch ${entityId} live at ${dims.width}x${dims.height}, ${rois.length} ROIs, sampling every ${intervalSec}s`);
      // Classifier tick: local, free, and fast - a trained model (e.g. the
      // cupboard door) now sees the live stream instead of 5-minute polls.
      if (cfg.watchClassifySeconds > 0 && cfg.crops[entityId]) {
        classifyTimer = setInterval(async () => {
          try {
            const r = await watchGrab(entityId);
            const v = r && r.meta && r.meta.classifier;
            if (!v) return;
            const tick = v.positive && (v.engine === 'onnx' || v.framingOk !== false) ? 1 : 0;
            const N = Math.max(1, cfg.watchClassifyPersistTicks);
            mgr.verdicts = mgr.verdicts || [];
            mgr.verdicts.push(tick);
            if (mgr.verdicts.length > N) mgr.verdicts.shift();
            const sum = mgr.verdicts.reduce((a, b) => a + b, 0);
            const sustained = N <= 1 ? tick === 1 :
              (mgr.verdicts.length >= N && sum >= Math.ceil(N * 0.85) &&
               mgr.verdicts.slice(-3).every((x) => x === 1));
            if (!sustained && sum <= N / 2) mgr.sustainedOpen = false; // rearm
            if (sustained && !mgr.sustainedOpen) {
              mgr.sustainedOpen = true;
              const now = Date.now();
              if (now - (mgr.lastClassifyEventMs || 0) >= cfg.watchCooldownSeconds * 1000) {
                mgr.lastClassifyEventMs = now;
                console.log(`[nest_headless] classifier SUSTAINED positive ${entityId} (${v.label} ${v.score}, ${sum}/${N} ticks)`);
                await postHaEvent('nest_headless_classifier_positive', {
                  entity_id: entityId, camera: entityId.replace(/^camera\./, ''),
                  label: v.label, score: v.score, sustained_ticks: sum,
                });
              }
            }
          } catch (e) { /* stream hiccup; health loop handles it */ }
        }, cfg.watchClassifySeconds * 1000);
      }
      if (cfg.samplesDir && cfg.sampleArchiveSeconds > 0) {
        // heartbeat: keep the timeline flowing at a steady cadence even when
        // nothing moves - motion-driven archives reset the clock via the
        // shared throttle, so busy periods don't double up
        heartbeatTimer = setInterval(() => {
          watchGrab(entityId).catch(() => { /* stream hiccup */ });
        }, cfg.sampleArchiveSeconds * 1000);
      }
      for (;;) { // hold the stream; HA extends the Google session while we stay connected
        await sleep(30000);
        const st = await page.evaluate(fns.connectionState);
        if (!['connected', 'completed'].includes(st.ice)) throw new Error('ice state ' + st.ice);
      }
    } catch (e) {
      mgr.ready = false; mgr.page = null; mgr.lastError = e.message;
      console.warn(`[nest_headless] watch ${entityId} down (${e.message}); retrying in 30s`);
    } finally {
      try { if (classifyTimer) clearInterval(classifyTimer); } catch (e) { /* ok */ }
      try { if (heartbeatTimer) clearInterval(heartbeatTimer); } catch (e) { /* ok */ }
      try { if (session) session.close(); } catch (e) { /* ok */ }
      try { if (page) await page.close(); } catch (e) { /* ok */ }
    }
    await sleep(30000);
  }
}

// ------------------------------------------------------------ HTTP API
function serveFile(res, entityId, extraHeaders = {}) {
  const file = cameraFile(entityId);
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404); res.end('no snapshot yet'); return; }
    const age = (Date.now() - st.mtimeMs) / 1000;
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': st.size,
      'X-Capture-Age-Seconds': age.toFixed(1),
      ...extraHeaders,
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    if (url.pathname === '/health') {
      res.writeHead(200); res.end('ok'); return;
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        addon: 'nest_headless', outDir: cfg.outDir,
        cameras: Object.fromEntries(Object.entries(state).map(([k, v]) => [k, v.lastMeta])),
        watches: Object.fromEntries(Object.entries(watchMgr).map(([k, m]) => [k, {
          ready: m.ready, hits: m.hits, startedAt: m.startedAt, lastError: m.lastError,
          verdictWindow: (m.verdicts || []).join(''), sustainedOpen: !!m.sustainedOpen,
        }])),
      }, null, 2));
      return;
    }
    if (parts[0] === 'latest' && parts[1]) {
      serveFile(res, cameraEntity(parts[1].replace(/\.jpg$/, '')));
      return;
    }
    if (parts[0] === 'watchstate' && parts[1]) {
      const entityId = cameraEntity(parts[1]);
      const mgr = watchMgr[entityId];
      let pageState = null;
      if (mgr && mgr.page) { try { pageState = await mgr.page.evaluate(fns.watchState); } catch (e) { pageState = { err: e.message }; } }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mgr: mgr ? { ready: mgr.ready, hits: mgr.hits, lastError: mgr.lastError } : null, page: pageState }));
      return;
    }
    if (parts[0] === 'detect' && parts[1]) {
      const entityId = cameraEntity(parts[1]);
      const { buf } = await captureCoalesced(entityId);
      const { cat, dets } = await catOnSurface(entityId, buf);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ cat_on_surface: cat, detections: dets }));
      return;
    }
    if (parts[0] === 'snapshot' && parts[1]) {
      const entityId = cameraEntity(parts[1]);
      const s = state[entityId];
      const fresh = url.searchParams.get('fresh') === '1';
      const ageMs = s ? Date.now() - s.lastCaptureMs : Infinity;
      if (!fresh && ageMs < cfg.minIntervalSeconds * 1000) {
        serveFile(res, entityId, { 'X-Cached': '1' }); // quota guard
        return;
      }
      const { buf, meta } = await captureCoalesced(entityId);
      if (url.searchParams.get('format') === 'json') {
        // for HA rest_command with response_variable: no binary body
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(meta));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': buf.length,
        'X-Capture-Age-Seconds': '0.0',
        'X-Mean-Luma': String(meta.meanLuma),
        'X-Width': String(meta.width),
        'X-Height': String(meta.height),
      });
      res.end(buf);
      return;
    }
    res.writeHead(404); res.end('unknown path');
  } catch (e) {
    console.error(`[nest_headless] ${url.pathname} failed:`, e.message);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('capture failed: ' + e.message);
  }
});

server.listen(cfg.port, () => {
  console.log(`[nest_headless] listening on :${cfg.port}`);
  for (const [entityId, interval] of Object.entries(cfg.watches)) {
    runWatch(entityId, interval).catch((e) => console.error(`[nest_headless] watch ${entityId} crashed:`, e.message));
  }
});

process.on('SIGTERM', async () => {
  try { const b = await browserPromise; if (b) await b.close(); } catch (e) { /* ok */ }
  process.exit(0);
});
