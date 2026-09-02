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

// Keep in lockstep with config.yaml `version` - consumers (Hearth) read it
// from GET / to detect that a deploy has landed.
const ADDON_VERSION = '1.9.0';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('ws');
const puppeteer = require('puppeteer-core');
const fns = require('./pagefns');
const { classify } = require('./classifier');
const infer = require('./infer');
const { parseWatchPassages, PassageTracker } = require('./passages');

// ------------------------------------------------------------ configuration
// HA config root: the supervisor mounts it at /homeassistant (or /config on
// older bases); outside the supervisor (e.g. a Mac on the LAN) point
// HA_CONFIG_DIR at the mounted config share. Bundled assets live next to
// this file, so __dirname works in both worlds.
const CONFIG_DIR = process.env.HA_CONFIG_DIR || (fs.existsSync('/homeassistant') ? '/homeassistant' : '/config');
const ASSETS_DIR = path.join(__dirname, 'assets');
const cfg = {
  port: intEnv('PORT', 8098),
  minIntervalSeconds: intEnv('MIN_INTERVAL_SECONDS', 10),
  jpegQuality: intEnv('JPEG_QUALITY', 85) / 100,
  captureTimeoutSeconds: intEnv('CAPTURE_TIMEOUT_SECONDS', 25),
  warmupFrames: intEnv('WARMUP_FRAMES', 3),
  // supervisor mounts HA config at /homeassistant (homeassistant_config map)
  // or /config (legacy map) depending on base/supervisor version
  outDir: process.env.OUT_DIR || path.join(CONFIG_DIR, 'www/nest'),
  chromiumPath: process.env.CHROMIUM_PATH || firstExisting(
    ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'], true),
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
  // Passage zones (doorways): polygons + optional inside point, see passages.js
  watchPassages: parseWatchPassages(process.env.WATCH_PASSAGES || ''),
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
  // Cameras whose microphone feeds the keyword spotter ("hey kitchen").
  // Space-separated names; empty disables the audio pipeline entirely.
  // Audio is processed in-memory only - nothing is ever written to disk.
  audioCameras: (process.env.AUDIO_CAMERAS || '').split(/\s+/).filter(Boolean).map((n) => 'camera.' + n.replace(/^camera\./, '')),
  // Speech capture after a keyword hit (see onAudioChunk): end on this much
  // silence after speech, or at the max; recogniser hot-loads from sttModelDir.
  speechSilenceMs: intEnv('SPEECH_SILENCE_MS', 800),
  speechMaxSeconds: intEnv('SPEECH_MAX_SECONDS', 15),   // safety stop only; captures close on silence
  sttModelDir: process.env.STT_MODEL_DIR || path.join(CONFIG_DIR, 'nest_models/stt'),
  // Optional whisper.cpp server (Metal on a Mac): POST /inference. Falls back
  // to the in-process recogniser when unreachable. e.g. http://127.0.0.1:8178
  sttUrl: (process.env.STT_URL || '').replace(/\/+$/, ''),
  // Voice identity: embeddings + enrolments under <config>/nest_models/identity/.
  // Raw enrolment WAVs are kept only when identity_keep_samples is on.
  identityDir: path.join(CONFIG_DIR, 'nest_models/identity'),
  identityKeepSamples: (process.env.IDENTITY_KEEP_SAMPLES || 'false') === 'true',
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
      // Polygon zones: "x1,y1:x2,y2:x3,y3..." (>=3 comma pairs). Rectangles
      // keep the original "x:y:w:h". Perspective makes rectangles bleed onto
      // the floor behind surfaces; polygons trace the actual counter edges.
      if (rest.includes(',')) {
        const pts = rest.split(':').map((pair) => pair.split(',').map(Number))
          .filter((q) => q.length === 2 && q.every(Number.isFinite));
        if (pts.length < 3) return { name, x: 0, y: 0, w: 0, h: 0 };
        const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
        const x = Math.min(...xs), y = Math.min(...ys);
        return { name, pts, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
      }
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
// Inference (onnxruntime, sherpa) runs in this process and can saturate the
// NAS; Chromium's WebRTC audio/network threads must always win that contention
// or the received audio gaps (jitter-buffer expand) and keyword spotting dies.
// Chromium is spawned at nice 0, then this process lowers itself to nice 10.
// Only matters on a starved host (2-core NAS); on a big box it is a no-op.
// Note: an unprivileged process cannot lower its nice again, so a Chromium
// relaunch after a browser crash inherits nice 10 - the container restart
// (supervisor watchdog) is what restores the split.
const INFERENCE_NICE = 10;
function setInferencePriority(low) {
  if (os.cpus().length >= 6) return;   // plenty of cores (the Mac): everything runs at normal priority, in parallel
  const cur = os.getPriority();
  const want = low ? Math.max(cur, INFERENCE_NICE) : cur;   // never try to go lower: EACCES
  if (want === cur) return;
  try { os.setPriority(want); } catch (e) { console.warn('[nest_headless] setPriority failed:', e.message); }
}
async function getBrowser() {
  if (!browserPromise) {
    setInferencePriority(false);
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
      setInferencePriority(true);
      console.log(`[nest_headless] chromium pid ${b.process() ? b.process().pid : '?'} at nice 0; node now nice ${os.getPriority()} (${os.cpus().length} cpus)`);
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
    await page.goto(`http://127.0.0.1:${cfg.port}/blank`);
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

// Passage tracking (Hearth #7): every doorway-motion hit runs the person
// detector (8 ms on CoreML) and feeds the camera's tracker; crossings become
// nest_headless_passage events. Own pacing (0.7 s), independent of the cat
// detection pacing below - people cross a doorway in about a second.
async function passageTick(entityId, mgr, frameBuf, now) {
  const passages = cfg.watchPassages[entityId] || [];
  if (!passages.length) return;
  if (now - (mgr.lastPassageMs || 0) < 700) return;
  mgr.lastPassageMs = now;
  try {
    const d = await infer.detect(frameBuf, { conf: 0.4, classes: [0, 24, 26, 28] });   // person, backpack, handbag, suitcase
    if (d === null) return;
    const persons = d.filter((x) => x.cls === 0), bags = d.filter((x) => x.cls !== 0);
    mgr.tracker = mgr.tracker || new PassageTracker(entityId, passages);
    for (const ev of mgr.tracker.update(persons, bags, now)) {
      console.log(`[nest_headless] PASSAGE ${ev.direction} ${ev.passage} on ${entityId} track ${ev.track_id} h=${ev.attributes.height_ratio} carrying=${ev.attributes.carrying}`);
      postHaEvent('nest_headless_passage', { entity_id: entityId, camera: entityId.replace(/^camera\./, ''), ...ev }).catch(() => {});
    }
  } catch (e) { console.warn(`[nest_headless] passage tick ${entityId} failed: ${e.message}`); }
}

async function watchHit(entityId, payload) {
  const mgr = watchMgr[entityId];
  if (!mgr) return;
  const now = Date.now();
  // Stream-settle grace: a freshly (re)connected stream shifts exposure and
  // resolution for its first seconds, which diffs like motion (fired a
  // phantom deterrent 6s after a restart). Ignore hits until it settles.
  if (now - (mgr.readySinceMs || 0) < 45000) return;
  if ((cfg.watchPassages[entityId] || []).length && payload.meanLuma >= 3) {
    passageTick(entityId, mgr, Buffer.from(payload.dataUrl.split(',')[1], 'base64'), now).catch(() => {});
  }
  if (String(payload.roi || '').startsWith('passage:')) return;   // doorway motion: tracked above, not a surface hit
  // Detection PACING, not the alert cooldown: the old shared 60s cooldown
  // gated detection itself, so any motion (a person passing) blinded the
  // zone check for the next minute - a cat could land and go unseen. Local
  // inference is free; look every 8s whenever motion is present, and keep
  // watch_cooldown_seconds solely for throttling repeat ALERTS below.
  if (now - (mgr.lastDetectMs || 0) < 8000) return;
  mgr.lastDetectMs = now;
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
  // Evidence for EVERY hit, verdict or not: "a cat was just there, did you
  // catch it?" has now been asked three times and each time the frames the
  // detector judged were already gone (only heartbeats and cat-positives
  // were kept). Own throttle (10s) + rotation, separate from the archive.
  saveHitSnapshot(entityId, frameBuf, dets, payload.roi);
  // Verdict comes from the detector alone. The "suspected" motion heuristic
  // shipped and was retired the same night: 3 firings, 0 cats (person-exit
  // wake, stream settle, lamp shimmer). The house-trained model replaces it.
  const verdict = cat;
  console.log(`[nest_headless] watch hit ${entityId} roi=${payload.roi} changed=${payload.changedPct}% cat=${verdict} dets=${dets ? dets.map((x) => x.name + ':' + x.conf).join(',') : 'n/a'}`);
  if (verdict === false) return;
  if (now - mgr.lastHitMs < cfg.watchCooldownSeconds * 1000) return; // alert repeat throttle
  mgr.lastHitMs = now;
  await postHaEvent('nest_headless_surface_activity', {
    entity_id: entityId,
    camera: entityId.replace(/^camera\./, ''),
    roi: payload.roi,
    changed_pct: payload.changedPct,
    cat: verdict,
    detections: dets ? dets.slice(0, 5) : null,
    people: await countPeople(frameBuf),
  });
}

const lastHitSnapMs = {};
function saveHitSnapshot(entityId, frameBuf, dets, roi) {
  try {
    if (!cfg.samplesDir) return;
    const now = Date.now();
    if (now - (lastHitSnapMs[entityId] || 0) < 10000) return;
    lastHitSnapMs[entityId] = now;
    const dir = path.join(cfg.samplesDir, entityId.replace(/^camera\./, '') + '_hits');
    fs.mkdirSync(dir, { recursive: true });
    const existing = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort();
    if (existing.length >= 600) {
      for (const f of existing.slice(0, 60)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* ok */ }
      }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const boxed = infer.annotate(frameBuf, dets || [], cfg.watchRois[entityId] || []);
    fs.writeFileSync(path.join(dir, `${stamp}_${roi}.jpg`), boxed);
  } catch (e) { /* evidence is best-effort */ }
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

// People in frame (COCO class 0, conf >= 0.5) - a count only, no event.
async function countPeople(frameBuf) {
  try {
    const d = await infer.detect(frameBuf, { conf: 0.5, classes: [0] });
    return d === null ? null : d.length;
  } catch (e) { return null; }
}

// Is a cat (or dog) standing on one of this camera's watched surfaces?
// Uses the box's bottom-centre - the animal's feet - for ROI membership.
// Returns { cat: true/false/null, dets } - null when the detector is
// unavailable (callers should treat that as "unknown", not "no").
async function catOnSurface(entityId, frameBuf) {
  try {
    const rois = cfg.watchRois[entityId] || [];
    if (!rois.length) return { cat: null, dets: null };
    // ONE full-frame pass. The region-zoom era (1.3.0-1.5.5) fed the
    // house model crops ~3x larger than anything it trained on - a proven
    // train/serve scale mismatch: the canonical raid frame scores 0.904
    // full-frame and NOTHING zoomed. Zoom existed for COCO's small-cat
    // blindness; the house model trained on these full frames and needs
    // the frame served the same way. (This both missed a real daylight cat
    // and let a wipes tub fire at zoom scale - full-frame fixes both.)
    const d = await infer.detectCats(frameBuf, { conf: 0.5 });
    if (d === null) return { cat: null, dets: null };
    const dets = [];
    let cat = false;
    for (const x of d) {
      // placement: the animal's feet (box bottom-centre) must be on a
      // watched surface, not the floor behind it
      const fx = x.box.x + x.box.w / 2, fy = x.box.y + x.box.h;
      const inPoly = (pts, px2, py2) => {
        let inside = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i], [xj, yj] = pts[j];
          if ((yi > py2) !== (yj > py2) && px2 < ((xj - xi) * (py2 - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
      };
      const onZone = (r) => r.pts
        // same vertical tolerance the rect check had: feet may render a
        // touch below the surface edge (+0.04) or above it (-0.02)
        ? (inPoly(r.pts, fx, fy) || inPoly(r.pts, fx, fy - 0.04) || inPoly(r.pts, fx, fy + 0.02))
        : (fx >= r.x && fx <= r.x + r.w && fy >= r.y - 0.02 && fy <= r.y + r.h + 0.04);
      const r = rois.find(onZone);
      dets.push({ ...x, roi: r ? r.name : null });
      if (r && (x.cls === 15 || x.cls === 16)) cat = true;
    }
    if (cat) saveCatSnapshot(entityId, frameBuf, dets);
    return { cat, dets };
  } catch (e) {
    console.warn(`[nest_headless] detect ${entityId} failed: ${e.message}`);
    return { cat: null, dets: null };
  }
}

// ------------------------------------------------------------ keyword spotting
let kwsCtx = null;
function getKws() {
  if (kwsCtx !== null) return kwsCtx;
  try {
    const sherpa = require('sherpa-onnx-node');
    const K = path.join(ASSETS_DIR, 'kws');
    const spotter = new sherpa.KeywordSpotter({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: K + '/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
          decoder: K + '/decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
          joiner: K + '/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
        },
        tokens: K + '/tokens.txt', numThreads: 2, provider: 'cpu',
      },
      // phrases hot-configurable: <config>/nest_models/keywords.txt (BPE token
      // lines, see DOCS) outranks the baked default - no rebuild to change
      keywordsFile: [path.join(CONFIG_DIR, 'nest_models/keywords.txt')]
        .find((f) => { try { return fs.existsSync(f); } catch (e) { return false; } }) || (K + '/keywords.txt'),
      // sensitivity: default threshold 0.25 / score 1.0 heard speech-level
      // audio (rms 0.02) and matched nothing; be more eager - a false
      // "Yes? I heard you." is cheap, a missed phrase is the feature failing
      keywordsThreshold: 0.12,
      keywordsScore: 2.0,
    });
    kwsCtx = { sherpa, spotter, streams: {} };
    console.log('[nest_headless] keyword spotter loaded');
  } catch (e) {
    console.warn('[nest_headless] keyword spotter unavailable:', e.message);
    kwsCtx = false;
  }
  return kwsCtx;
}

// ------------------------------------------------------------ speech-to-text
// Offline recogniser (sherpa-onnx streaming zipformer transducer) hot-loaded
// from cfg.sttModelDir: encoder*.onnx, decoder*.onnx, joiner*.onnx, tokens.txt.
// Default recogniser is the keyword spotter's own gigaspeech transducer (same
// files, already resident): on far-field kitchen audio it transcribed a
// question the LibriSpeech en-20M model returned "" for. The local transcript
// is a fallback; the brain gets the raw utterance (GET /utterance/<id>.wav)
// and can run Whisper on real hardware.
let sttCtx = null;
function getStt() {
  if (sttCtx !== null) return sttCtx;
  try {
    const sherpa = require('sherpa-onnx-node');
    const K = path.join(ASSETS_DIR, 'kws');
    const d = cfg.sttModelDir && fs.existsSync(cfg.sttModelDir) ? cfg.sttModelDir : null;
    const pick = (prefix, preferInt8) => {
      const fsx = fs.readdirSync(d).filter((f) => f.startsWith(prefix) && f.endsWith('.onnx'));
      const i8 = fsx.find((f) => f.includes('int8'));
      return path.join(d, (preferInt8 && i8) ? i8 : (fsx.find((f) => !f.includes('int8')) || i8));
    };
    // Whisper (sherpa-onnx OfflineRecognizer): a dir holding <name>-encoder*.onnx,
    // <name>-decoder*.onnx, <name>-tokens.txt. small.en int8 transcribes an
    // 8 s utterance in ~0.6 s on an M3 Pro and is the product; the
    // transducers below are the fallback for hosts that cannot afford it.
    const wfiles = d ? fs.readdirSync(d) : [];
    const wEnc = wfiles.find((f) => /-encoder\.int8\.onnx$/.test(f)) || wfiles.find((f) => /-encoder\.onnx$/.test(f));
    const wDec = wfiles.find((f) => /-decoder\.int8\.onnx$/.test(f)) || wfiles.find((f) => /-decoder\.onnx$/.test(f));
    const wTok = wfiles.find((f) => /-tokens\.txt$/.test(f));
    if (wEnc && wDec && wTok) {
      const name = wEnc.replace(/-encoder.*$/, '');
      const rec = new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          whisper: { encoder: path.join(d, wEnc), decoder: path.join(d, wDec), language: 'en', task: 'transcribe', tailPaddings: -1 },
          tokens: path.join(d, wTok), numThreads: Math.max(2, Math.min(6, os.cpus().length - 2)), provider: 'cpu', debug: 0,
        },
        decodingMethod: 'greedy_search',
      });
      sttCtx = { rec, kind: 'offline', engine: `whisper-${name}` };
      console.log(`[nest_headless] speech recogniser loaded: whisper ${name} from ${d}`);
      return sttCtx;
    }
    const transducer = d
      ? { encoder: pick('encoder', true), decoder: pick('decoder', false), joiner: pick('joiner', true) }
      : {
        encoder: K + '/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
        decoder: K + '/decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
        joiner: K + '/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx',
      };
    const rec = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: { transducer, tokens: d ? path.join(d, 'tokens.txt') : K + '/tokens.txt', numThreads: 2, provider: 'cpu' },
      decodingMethod: 'greedy_search',
    });
    sttCtx = { rec, kind: 'online', engine: d ? 'zipformer-' + path.basename(d) : 'zipformer-gigaspeech-3.3M' };
    console.log(`[nest_headless] speech recogniser loaded from ${d || 'built-in gigaspeech transducer'}`);
  } catch (e) {
    console.warn('[nest_headless] speech recogniser unavailable:', e.message);
    sttCtx = false;
  }
  return sttCtx;
}

// ------------------------------------------------------------ voice identity
// Speaker embeddings (sherpa-onnx SpeakerEmbeddingExtractor, model hot-loaded
// from identity/models/speaker.onnx) matched by cosine against enrolled
// people. The add-on never decides identity or enrols on its own: it reports
// scores; the brain (Hearth) owns consent and the decision.
let spkCtx = null;
function getSpeakerExtractor() {
  if (spkCtx !== null) return spkCtx;
  try {
    const sherpa = require('sherpa-onnx-node');
    const model = path.join(cfg.identityDir, 'models', 'speaker.onnx');
    if (!fs.existsSync(model)) { spkCtx = false; return spkCtx; }
    spkCtx = { ex: new sherpa.SpeakerEmbeddingExtractor({ model, numThreads: 2, provider: 'cpu' }) };
    console.log('[nest_headless] speaker embedding model loaded');
  } catch (e) { console.warn('[nest_headless] speaker model unavailable:', e.message); spkCtx = false; }
  return spkCtx;
}
function embedVoice(samples) {
  const k = getSpeakerExtractor();
  if (!k) return null;
  const st = k.ex.createStream();
  st.acceptWaveform({ samples, sampleRate: 16000 });
  st.inputFinished();
  return Array.from(k.ex.compute(st));
}
const cosine = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / Math.sqrt(na * nb || 1); };
// enrolled: { name: [ {embedding, file} ] } loaded from identity/<name>/voice-*.json
let enrolled = null;
function loadEnrolled() {
  enrolled = {};
  try {
    for (const name of fs.readdirSync(cfg.identityDir)) {
      const d = path.join(cfg.identityDir, name);
      if (name === 'models' || !fs.statSync(d).isDirectory()) continue;
      const items = [];
      for (const f of fs.readdirSync(d)) {
        if (!/^voice-.*\.json$/.test(f)) continue;
        try { const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); if (Array.isArray(j.embedding)) items.push({ embedding: j.embedding, file: f, at: j.at }); } catch (e) { /* skip */ }
      }
      if (items.length) enrolled[name] = items;
    }
  } catch (e) { /* no identity dir yet */ }
  return enrolled;
}
function matchVoice(embedding) {
  if (!enrolled) loadEnrolled();
  const out = [];
  for (const [name, items] of Object.entries(enrolled)) {
    const best = Math.max(...items.map((it) => cosine(embedding, it.embedding)));
    out.push({ name, score: Math.round(best * 1000) / 1000 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}
// recent utterances kept 90 s for enrolment: id -> {camera, samples, quality, embedding, at}
const utterances = new Map();
function rememberUtterance(id, u) {
  utterances.set(id, u);
  setTimeout(() => utterances.delete(id), 90000).unref();
}
function latestUtterance(entityId) {
  let best = null;
  for (const u of utterances.values()) if (u.camera === entityId && (!best || u.at > best.at)) best = u;
  return best;
}
function voiceQuality(c, samples) {
  const voicedMs = c.chunks.filter((ch) => rmsOf(ch) > c.floor).reduce((a, ch) => a + ch.length / 16, 0);
  const rms = rmsOf(samples);
  let reason = 'ok';
  if (voicedMs < 2000) reason = 'too_short';
  else if (rms < c.floor) reason = 'too_quiet';
  return { speech_ms: Math.round(voicedMs), rms: Math.round(rms * 10000) / 10000, reason };
}
function writeWav16k(file, samples) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
}
function enrolVoice(name, u) {
  if (!/^[a-z0-9_-]{1,32}$/i.test(name)) return { ok: false, accepted: false, reason: 'bad_name' };
  if (!u) return { ok: false, accepted: false, reason: 'no_utterance' };
  if (u.quality.reason !== 'ok') {
    // measured numbers alongside the reason so the brain can coach ("that was two seconds, I need about four")
    return { ok: true, accepted: false, quality: u.quality, reason: u.quality.reason,
      speech_ms: u.quality.speech_ms, rms: u.quality.rms, needed_speech_ms: 2000,
      samples: (enrolled && enrolled[name] || []).length };
  }
  const emb = u.embedding || embedVoice(u.samples);
  if (!emb) return { ok: false, accepted: false, reason: 'no_model' };
  const d = path.join(cfg.identityDir, name.toLowerCase());
  fs.mkdirSync(d, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(d, `voice-${ts}.json`), JSON.stringify({ at: new Date().toISOString(), camera: u.camera, quality: u.quality, embedding: emb }));
  if (cfg.identityKeepSamples) writeWav16k(path.join(d, `voice-${ts}.wav`), u.samples);
  loadEnrolled();
  console.log(`[nest_headless] IDENTITY enrolled voice for ${name.toLowerCase()} (${enrolled[name.toLowerCase()].length} samples)`);
  return { ok: true, accepted: true, quality: u.quality, samples: enrolled[name.toLowerCase()].length };
}
function forgetPerson(name) {
  const d = path.join(cfg.identityDir, name.toLowerCase());
  if (!/^[a-z0-9_-]{1,32}$/i.test(name) || !fs.existsSync(d)) return { ok: false, reason: 'unknown' };
  fs.rmSync(d, { recursive: true, force: true });
  loadEnrolled();
  return { ok: true };
}
function identitySummary() {
  if (!enrolled) loadEnrolled();
  return { people: Object.entries(enrolled).map(([name, items]) => ({
    name, voice_samples: items.length, face_samples: 0,
    updated_at: items.map((i) => i.at).sort().pop() || null,
  })) };
}
function readJsonBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } });
  });
}

// Per-camera capture state: after a keyword hit, accumulate 16k samples until
// silence-after-speech or the max window, then recognise and post ONE event.
const speechCap = {};
function rmsOf(a) { let acc = 0; for (let i = 0; i < a.length; i++) acc += a[i] * a[i]; return Math.sqrt(acc / Math.max(1, a.length)); }
// opts.followUp (Hearth #4): a listening window opened by the brain right
// after it has spoken - no wake phrase, so no tail phase; a short pre-roll;
// gives up silently after opts.giveUpMs if nobody speaks.
function startSpeechCapture(entityId, keyword, ring, opts = {}) {
  // ~1.5 s pre-roll: the spotter fires 0.3-0.7 s after the phrase, so someone
  // who runs straight on ("hey claude is the...") has already said the start
  // of the question. Whisper gets the wake phrase too; it is stripped from
  // the transcript afterwards (stripWakePhrase).
  const pre = [];
  let need = opts.followUp ? 4800 : 24000;
  for (let i = ring.length - 1; i >= 0 && need > 0; i--) { pre.unshift(ring[i]); need -= ring[i].length; }
  // Noise floor from the ring's quietest tenth (x3), clamped to 0.006-0.015:
  // a ring full of conversation or a spoken answer must not lift the floor
  // above a normal voice (0.02-0.3 rms at this mic); 0.015 is well above the
  // kitchen's ambient 0.003-0.005.
  const rmses = ring.map(rmsOf).sort((a, b) => a - b);
  const floor = Math.min(0.015, Math.max(0.006, (rmses[Math.floor(rmses.length * 0.1)] || 0.006) * 3));
  speechCap[entityId] = {
    keyword, chunks: [...pre], startedAt: new Date(), t0: Date.now(),
    floor, phase: opts.followUp ? 'listen' : 'tail', tailQuietMs: 0, keepFrom: opts.followUp ? 0 : pre.length,
    listenT0: opts.followUp ? Date.now() : null, voicedMs: 0, silenceMs: 0,
    followUp: !!opts.followUp, giveUpMs: opts.giveUpMs || 0,
  };
}
// End-pointing (Hearth #3). The spotter fires mid-phrase ("hey cl..."), so
// the audio after the hit starts with the wake phrase's own tail; counting
// that as "has spoken" let the natural pause after it close the window
// before the question began. Phases:
//   tail   - wait for the wake phrase to end: the first >= 300 ms below the
//            speech floor. Nothing here counts as speech, and the recogniser
//            audio starts after it. If no gap shows up within 1.2 s the
//            person ran straight on ("hey claude is the..."): keep the audio
//            from the hit and start listening.
//   listen - up to 3 s of initial quiet (people wait for an acknowledgement);
//            >= 500 ms voiced before `speech_silence_ms` of quiet can close
//            it; speech_max_seconds is the hard stop throughout.
const TAIL_GAP_MS = 300, TAIL_MAX_MS = 1200, SPEECH_MIN_VOICED_MS = 500, SPEECH_INITIAL_QUIET_MS = 3000;
function feedSpeechCapture(entityId, chunk) {
  const c = speechCap[entityId];
  if (!c) return;
  c.chunks.push(chunk);
  const ms = chunk.length / 16, elapsed = Date.now() - c.t0, rms = rmsOf(chunk);
  let reason = null;
  if (c.phase === 'tail') {
    const voiced = rms > c.floor;
    c.tailQuietMs = voiced ? 0 : c.tailQuietMs + ms;
    if (c.tailQuietMs >= TAIL_GAP_MS) { c.phase = 'listen'; c.keepFrom = 0; c.listenT0 = Date.now(); }   // keep the pre-roll: Whisper confirms the wake phrase from it, then it is stripped
    else if (elapsed >= TAIL_MAX_MS) { c.phase = 'listen'; c.keepFrom = 0; c.listenT0 = Date.now(); c.voicedMs = TAIL_MAX_MS; c.peakRms = rms; }   // ran straight on: keep the pre-roll (the question started in it) and count the run-on as speech already
    else if (elapsed >= cfg.speechMaxSeconds * 1000) reason = 'no_speech';
    if (!reason) return;
  } else {
    // Once speech has been heard, "quiet" is judged relative to that speech
    // (18% of its running peak, never below the floor): kitchen bustle at
    // 0.01-0.06 rms sat above a fixed floor and kept captures open to the
    // hard stop (Hearth #3, 8 s for a 3.5 s question). The absolute floor
    // still decides whether anything was said at all.
    c.peakRms = Math.max(c.peakRms || 0, rms);
    const heard = c.voicedMs >= SPEECH_MIN_VOICED_MS;
    const quietBelow = heard ? Math.max(c.floor, 0.18 * c.peakRms) : c.floor;
    const voiced = rms > quietBelow;
    if (voiced) { c.voicedMs += ms; c.silenceMs = 0; } else c.silenceMs += ms;
    const spoke = c.voicedMs >= SPEECH_MIN_VOICED_MS, listened = Date.now() - c.listenT0;
    if (spoke && c.silenceMs >= cfg.speechSilenceMs) reason = 'silence';
    else if (!c.voicedMs && listened >= (c.giveUpMs || SPEECH_INITIAL_QUIET_MS)) reason = 'no_speech';
    else if (!spoke && c.voicedMs && c.silenceMs >= 2000) reason = 'no_speech';   // a grunt, then nothing
    else if (elapsed >= cfg.speechMaxSeconds * 1000) reason = spoke ? 'max_seconds' : 'no_speech';
    if (!reason) return;
    c.spoke = spoke;
  }
  delete speechCap[entityId];
  finishSpeechCapture(entityId, c, reason).catch((e) => console.warn('[nest_headless] speech capture failed:', e.message));
}
// Drop the wake phrase (and anything before it) from a transcript that
// includes the pre-roll. Spellings cover how the recognisers render "Claude"
// for the voices in this house ("Claws", "God", "Cloud", ...).
// whisper.cpp `whisper-server` (POST /inference, multipart "file" = 16 kHz
// mono WAV). Audio goes over loopback and is never written to disk.
function wavBuffer(samples) {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
  h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
function whisperServer(samples) {
  return new Promise((resolve, reject) => {
    const boundary = '----nest' + Date.now().toString(36);
    const field = (name, value) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="u.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      wavBuffer(samples), Buffer.from('\r\n'),
      field('response_format', 'json'), field('temperature', '0'), field('language', 'en'),
      Buffer.from(`--${boundary}--\r\n`),
    ]);
    const u = new URL(cfg.sttUrl + '/inference');
    const req = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST', timeout: 8000,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`http ${res.statusCode}`));
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ text: String(j.text || '').trim(), engine: String(j.engine || 'whisper-server') + (j.model ? ':' + String(j.model).replace(/^.*\//, '') : '') });
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}
const WAKE_NAMES = 'claude|claud|clawed|claws|clause|cloud|cloudy|clod|clawd|klaud|klaus|clyde|cord|god|kitchen';
const WAKE_RE = new RegExp(`^[\\s\\S]*?\\b(?:hey|hi|ok|okay)[,.!?]?\\s+(?:${WAKE_NAMES})\\b[,.!?]*\\s*`, 'i');
// pre-roll cut mid-phrase: transcript starts with the bare name ("clawed, is the...")
const WAKE_HEAD_RE = new RegExp(`^\\W*(?:${WAKE_NAMES})\\b[,.!?]*\\s*`, 'i');
function stripWakePhrase(t) {
  for (let i = 0; i < 3; i++) {   // "hey claude, hey claude, ..." - strip repeats too
    const m = WAKE_RE.exec(t) || WAKE_HEAD_RE.exec(t);
    if (!m) break;
    t = t.slice(m[0].length).trim();
  }
  return t;
}
async function finishSpeechCapture(entityId, c, reason) {
  if (c.followUp && reason === 'no_speech') {   // nobody replied: no event at all (Hearth #4)
    console.log(`[nest_headless] follow-up window on ${entityId} closed: nobody spoke`);
    return;
  }
  const endedAt = new Date();
  // recogniser audio starts after the wake phrase's tail (see feedSpeechCapture)
  const kept = c.chunks.slice(Math.min(c.keepFrom || 0, Math.max(0, c.chunks.length - 1)));
  const total = kept.reduce((a, b) => a + b.length, 0);
  const all = new Float32Array(total); let o = 0;
  for (const ch of kept) { all.set(ch, o); o += ch.length; }
  // Normalise for the recogniser (peak to -3 dBFS, at most x20): the mic sits
  // above the patio doors and speech from the far side of the kitchen arrives
  // at rms 0.01-0.08, which Whisper reads as noise; scaled, it reads it fine.
  let peak = 0;
  for (let i = 0; i < all.length; i++) { const a = Math.abs(all[i]); if (a > peak) peak = a; }
  const gain = peak > 0 ? Math.min(20, 0.7 / peak) : 1;
  if (gain > 1.05) for (let i = 0; i < all.length; i++) all[i] = Math.max(-1, Math.min(1, all[i] * gain));
  let text = '';
  let stt = reason === 'no_speech' ? null : getStt();
  const tStt = Date.now();
  let remote = null;
  if (reason !== 'no_speech' && cfg.sttUrl) {
    remote = await whisperServer(all).catch((e) => { console.warn('[nest_headless] whisper server failed, using local recogniser:', e.message); return null; });
  }
  if (remote) {
    text = remote.text; stt = { engine: remote.engine };
  } else if (stt && stt.kind === 'offline') {
    const st = stt.rec.createStream();
    st.acceptWaveform({ samples: all, sampleRate: 16000 });
    stt.rec.decode(st);
    const r = stt.rec.getResult(st);
    text = ((r && r.text) || '').trim();
  } else if (stt) {
    const st = stt.rec.createStream();
    st.acceptWaveform({ samples: all, sampleRate: 16000 });
    st.acceptWaveform({ samples: new Float32Array(16000), sampleRate: 16000 }); // 1 s zero pad flushes the last word (input_finished alone does not)
    while (stt.rec.isReady(st)) stt.rec.decode(st);
    const r = stt.rec.getResult(st);
    text = ((r && r.text) || '').trim().toLowerCase();
  }
  const sttMs = Date.now() - tStt;
  // The spotter is deliberately eager (threshold 0.12) and fires on ordinary
  // talk now and then; Whisper hearing the wake phrase in the pre-roll is
  // the second opinion. Unconfirmed captures are still sent - the brain
  // decides - but flagged, so an 8 s ramble after a false wake is cheap to
  // discard.
  const wakeConfirmed = !!text && (WAKE_RE.test(text) || WAKE_HEAD_RE.test(text));
  text = stripWakePhrase(text);
  // Whisper's stage directions - "(baby crying)", "[inaudible]", "(background
  // noise drowns out speaker)" - are not something the brain should parse.
  if (text && /^[\s(\[][^A-Za-z0-9]*[^()\[\]]*[)\]]\W*$/.test(text) && !/[a-z]{2,}\s+[a-z]{2,}.*[a-z]/i.test(text.replace(/[(\[][^)\]]*[)\]]/g, ''))) { text = ''; reason = 'unclear'; }
  if (c.followUp && !text) {   // a follow-up window that caught only noise is the same as nobody replying (Hearth #4)
    console.log(`[nest_headless] follow-up window on ${entityId} closed: nothing intelligible (${reason})`);
    return;
  }
  const durationMs = Math.round(total / 16);
  const utteranceId = `${entityId.replace(/^camera\./, '')}-${c.t0}`;
  console.log(`[nest_headless] SPEECH "${text}" on ${entityId} (${durationMs} ms, ${reason}, ${stt ? stt.engine : 'no-stt'} ${sttMs} ms, wake ${wakeConfirmed ? 'confirmed' : 'unconfirmed'})`);
  await postHaEvent('nest_headless_speech', {
    entity_id: entityId, camera: entityId.replace(/^camera\./, ''), keyword: c.keyword,
    utterance_id: utteranceId,
    text, duration_ms: durationMs, started_at: c.startedAt.toISOString(), ended_at: endedAt.toISOString(),
    reason: text ? reason : (reason === 'no_speech' ? 'no_speech' : reason),
    engine: stt ? stt.engine : null, stt_ms: sttMs, final: true,
    wake_confirmed: wakeConfirmed,   // Whisper heard the wake phrase in the pre-roll (false = likely a spotter false alarm)
    // raw 16 kHz mono WAV, memory-held for 90 s, for a stronger recogniser on the brain
    audio_path: `/utterance/${utteranceId}.wav`, audio_ttl_s: 90,
  });
  // Identity follows as its own event so it can never delay the transcript.
  const quality = voiceQuality(c, all);
  const u = { camera: entityId, samples: all, quality, embedding: null, at: Date.now() };
  rememberUtterance(utteranceId, u);
  try {
    if (quality.reason === 'ok' || quality.speech_ms >= 800) u.embedding = embedVoice(all);
    const matches = u.embedding ? matchVoice(u.embedding) : [];
    await postHaEvent('nest_headless_identity', {
      entity_id: entityId, camera: entityId.replace(/^camera\./, ''), utterance_id: utteranceId,
      speaker: { quality, matches }, faces: [],
    });
  } catch (e) { console.warn('[nest_headless] identity failed:', e.message); }
}

const lastKeywordMs = {};
const audioStats = {};   // per camera: chunks, lastRms, rate, resampledLen, hits, lastError
function onAudioChunk(entityId, b64, sampleRate) {
  const st0 = audioStats[entityId] || (audioStats[entityId] = { chunks: 0, lastRms: 0, rate: sampleRate, resampledLen: 0, hits: 0, lastError: null });
  st0.chunks++; st0.rate = sampleRate;
  const k = getKws();
  if (!k) { st0.lastError = 'no spotter'; return; }
  try {
    const raw = Buffer.from(b64, 'base64');
    const i16 = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1);
    let f32 = new Float32Array(i16.length);
    let acc = 0;
    for (let i = 0; i < i16.length; i++) { f32[i] = i16[i] / 32768; acc += f32[i] * f32[i]; }
    st0.lastRms = Math.round(Math.sqrt(acc / Math.max(1, i16.length)) * 10000) / 10000;
    let st = k.streams[entityId];
    if (!st) {
      st = k.streams[entityId] = {
        s: k.spotter.createStream(),
        rs: sampleRate !== 16000 ? new k.sherpa.LinearResampler(sampleRate, 16000) : null,
      };
    }
    if (st.rs) { const r = st.rs.resample(f32, false); f32 = r.samples || r; }
    st0.resampledLen = f32.length;
    // diagnostic ring buffer: last ~8s of 16k audio, memory only, served by
    // GET /audiodebug/<camera>.wav on explicit request - never persisted
    st.ring = st.ring || [];
    st.ring.push(Float32Array.from(f32));
    while (st.ring.length > 32) st.ring.shift();   // ~8s at 250ms chunks
    feedSpeechCapture(entityId, f32);
    // Light AGC for the spotter only (the ring keeps raw audio; utterances
    // are normalised separately for the recogniser): a wake phrase from the
    // far side of the kitchen arrives at peak 0.05-0.1 and the small model
    // misses it; scaled to a recent-peak target of 0.5 (gain <= 8x) it does
    // not. False wakes this invites are caught downstream by wake_confirmed.
    let pk = 0;
    for (let i = 0; i < f32.length; i++) { const a = Math.abs(f32[i]); if (a > pk) pk = a; }
    st.peaks = st.peaks || [];
    st.peaks.push(pk); while (st.peaks.length > 8) st.peaks.shift();   // ~2 s window
    const recentPeak = Math.max(...st.peaks, 0.02);
    const g = Math.min(8, Math.max(1, 0.5 / recentPeak));
    const spot = g > 1.05 ? Float32Array.from(f32, (v) => Math.max(-1, Math.min(1, v * g))) : f32;
    st.s.acceptWaveform({ samples: spot, sampleRate: 16000 });
    while (k.spotter.isReady(st.s)) {
      k.spotter.decode(st.s);
      const r = k.spotter.getResult(st.s);
      if (r && r.keyword) {
        k.spotter.reset(st.s);
        const now = Date.now();
        if (speechCap[entityId]) continue;                       // capture in progress: no re-trigger
        if (now - (lastKeywordMs[entityId] || 0) < 2500) continue;
        lastKeywordMs[entityId] = now; st0.hits++;
        console.log(`[nest_headless] KEYWORD "${r.keyword}" on ${entityId} at ${new Date().toISOString()}`);
        postHaEvent('nest_headless_keyword', {
          entity_id: entityId, camera: entityId.replace(/^camera\./, ''), keyword: r.keyword,
        }).catch(() => {});
        startSpeechCapture(entityId, r.keyword, st.ring || []);
      }
    }
  } catch (e) { st0.lastError = e.message; console.warn('[nest_headless] audio chunk failed:', e.message); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runWatch(entityId, intervalSec) {
  const mgr = watchMgr[entityId] = { ready: false, hits: 0, lastHitMs: 0, lastError: null, page: null };
  const surfaces = cfg.watchRois[entityId] || [];
  // passage zones join the page's motion mask (named "passage:<name>") so a
  // person in a doorway produces hits; they are never cat surfaces
  const rois = surfaces.concat((cfg.watchPassages[entityId] || []).map((p) => ({ name: 'passage:' + p.name, pts: p.pts, x: p.x, y: p.y, w: p.w, h: p.h })));
  // No ROIs is fine: the stream still serves instant snapshots and classify
  // ticks - there is just no surface-motion event source for this camera.
  for (;;) {
    let page = null, session = null, classifyTimer = null, heartbeatTimer = null;
    try {
      const browser = await getBrowser();
      page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${cfg.port}/blank`);
      await page.exposeFunction('__watchHitNode', (payload) =>
        watchHit(entityId, payload).catch((e) => console.warn('[nest_headless] watch hit failed:', e.message)));
      if (cfg.audioCameras.includes(entityId)) {
        await page.exposeFunction('__audioChunkNode', (b64, rate) => onAudioChunk(entityId, b64, rate));
      }
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
      if (cfg.audioCameras.includes(entityId)) {
        const au = await page.evaluate(fns.startWatchAudio).catch((e) => ({ ok: false, reason: e.message }));
        console.log(`[nest_headless] audio tap ${entityId}:`, JSON.stringify(au));
        if (kwsCtx && kwsCtx.streams) delete kwsCtx.streams[entityId]; // fresh stream state per (re)connect
      }
      mgr.page = page; mgr.ready = true; mgr.startedAt = new Date().toISOString(); mgr.lastError = null;
      mgr.readySinceMs = Date.now();
      mgr.lastPersonMs = Date.now(); // cold start: assume people were just about
      console.log(`[nest_headless] watch ${entityId} live at ${dims.width}x${dims.height}, ${surfaces.length} surfaces, ${(cfg.watchPassages[entityId] || []).length} passages, sampling every ${intervalSec}s`);
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
  // Read fully, then send: the watch loop rewrites this file every second, so
  // stat-then-stream raced the writer and the Content-Length mismatch reset
  // the connection (curl exit 56 on /latest).
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404); res.end('no snapshot yet'); return; }
    fs.readFile(file, (err2, data) => {
      if (err2) { res.writeHead(404); res.end('no snapshot yet'); return; }
      const age = (Date.now() - st.mtimeMs) / 1000;
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': data.length,
        'X-Capture-Age-Seconds': age.toFixed(1),
        ...extraHeaders,
      });
      res.end(data);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    if (url.pathname === '/blank') {
      // watch pages load this instead of about:blank: localhost is a secure
      // context, which AudioWorklet requires (about:blank is opaque-origin)
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<!doctype html><title>nest_headless watch</title>');
    }
    if (url.pathname === '/health') {
      res.writeHead(200); res.end('ok'); return;
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        addon: 'nest_headless', outDir: cfg.outDir,
        cameras: Object.fromEntries(Object.entries(state).map(([k, v]) => [k, v.lastMeta])),
        addon: 'nest_headless', version: ADDON_VERSION,
        cpus: os.cpus().length, nice: os.getPriority(), load: os.loadavg().map((v) => +v.toFixed(2)),
        audio: audioStats, capturing: Object.keys(speechCap),
        watches: Object.fromEntries(Object.entries(watchMgr).map(([k, m]) => [k, {
          ready: m.ready, hits: m.hits, startedAt: m.startedAt, lastError: m.lastError,
          verdictWindow: (m.verdicts || []).join(''), sustainedOpen: !!m.sustainedOpen,
          passages: (cfg.watchPassages[k] || []).map((p) => p.name), tracks: m.tracker ? m.tracker.tracks.length : 0,
        }])),
      }, null, 2));
      return;
    }
    if (parts[0] === 'latest' && parts[1]) {
      serveFile(res, cameraEntity(parts[1].replace(/\.jpg$/, '')));
      return;
    }
    if (parts[0] === 'audiodebug' && parts[1]) {
      const cam = 'camera.' + parts[1].replace(/\.wav$/, '');
      const st = kwsCtx && kwsCtx.streams && kwsCtx.streams[cam];
      if (!st || !st.ring || !st.ring.length) { res.writeHead(404); return res.end('no audio buffered'); }
      const n = st.ring.reduce((a, b) => a + b.length, 0);
      const pcm = Buffer.alloc(n * 2); let o = 0;
      for (const c of st.ring) for (let i = 0; i < c.length; i++) { pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(c[i] * 32767))), o); o += 2; }
      const h = Buffer.alloc(44);
      h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
      h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
      h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
      res.writeHead(200, { 'Content-Type': 'audio/wav' }); return res.end(Buffer.concat([h, pcm]));
    }
    if (parts[0] === 'utterance' && parts[1]) {
      // the audio behind a nest_headless_speech event (utterance_id), while it
      // is still in memory (90 s); never written to disk here
      const u = utterances.get(parts[1].replace(/\.wav$/, ''));
      if (!u || !u.samples) { res.writeHead(404); return res.end('no such utterance (expired after 90 s?)'); }
      const pcm = Buffer.alloc(u.samples.length * 2);
      for (let i = 0; i < u.samples.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(u.samples[i] * 32767))), i * 2);
      const h = Buffer.alloc(44);
      h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
      h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24);
      h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'X-Utterance-Age-Seconds': String(Math.round((Date.now() - u.at) / 1000)) });
      return res.end(Buffer.concat([h, pcm]));
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
    if (parts[0] === 'listen' && parts[1] && req.method === 'POST') {
      // Follow-up window (Hearth #4): the brain has just spoken on this
      // camera's speaker and invites a reply. Same end-pointing and the same
      // nest_headless_speech event as a wake word, keyword "follow-up"; no
      // event at all if nobody speaks within ?seconds (default 8, max 30).
      const entityId = cameraEntity(parts[1]);
      const st = kwsCtx && kwsCtx.streams && kwsCtx.streams[entityId];
      if (!st) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, reason: 'no_audio_stream' })); }
      if (speechCap[entityId]) { res.writeHead(409, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, reason: 'capture_in_progress' })); }
      const seconds = Math.max(1, Math.min(30, parseFloat(url.searchParams.get('seconds')) || 8));
      startSpeechCapture(entityId, 'follow-up', st.ring || [], { followUp: true, giveUpMs: seconds * 1000 });
      console.log(`[nest_headless] LISTEN follow-up window ${seconds}s on ${entityId}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, camera: entityId.replace(/^camera\./, ''), seconds }));
    }
    if (parts[0] === 'identity') {
      if (req.method === 'GET' && !parts[1]) {
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(identitySummary()));
      }
      if (req.method === 'POST' && parts[1] === 'voice' && parts[2] === 'enrol') {
        const body = await readJsonBody(req);
        const cam = body.camera ? cameraEntity(body.camera) : null;
        const u = body.utterance_id ? utterances.get(body.utterance_id) : (cam ? latestUtterance(cam) : null);
        const r = enrolVoice(String(body.name || ''), u);
        res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(r));
      }
      if (req.method === 'DELETE' && parts[1]) {
        const r = forgetPerson(parts[1]);
        res.writeHead(r.ok ? 200 : 404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(r));
      }
      res.writeHead(404); return res.end('unknown identity route');
    }
    if (parts[0] === 'frame' && parts[1]) {
      // Instant JPEG off the held stream - no persist, detect, or archive.
      // /snapshot's fast path still runs persistShot (annotate + archive on
      // the NAS CPU) and falls into a full re-dial when that stalls, hence
      // the 30-45 s Hearth measured.
      const entityId = cameraEntity(parts[1]);
      const mgr = watchMgr[entityId];
      if (!mgr || !mgr.ready || !mgr.page) { res.writeHead(404); return res.end('camera not in watch mode'); }
      const t0 = Date.now();
      const shot = await mgr.page.evaluate(fns.grabFrame, { quality: cfg.jpegQuality, crop: null });
      const jpg = Buffer.from(shot.dataUrl.split(',')[1], 'base64');
      res.writeHead(200, {
        'Content-Type': 'image/jpeg', 'Content-Length': jpg.length,
        'X-Capture-Age-Seconds': ((Date.now() - t0) / 1000).toFixed(2),
        'X-Mean-Luma': String(Math.round(shot.meanLuma * 10) / 10),
        'X-Width': String(shot.width), 'X-Height': String(shot.height),
      });
      return res.end(jpg);
    }
    if (parts[0] === 'detect' && parts[1]) {
      const entityId = cameraEntity(parts[1]);
      const { buf } = await captureCoalesced(entityId);
      const { cat, dets } = await catOnSurface(entityId, buf);
      const people = await countPeople(buf);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ cat_on_surface: cat, detections: dets, people }));
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
  infer.warmUp().then((ms) => console.log(`[nest_headless] vision models warm in ${ms} ms`)).catch((e) => console.warn('[nest_headless] warm-up failed:', e.message));
  for (const [entityId, interval] of Object.entries(cfg.watches)) {
    runWatch(entityId, interval).catch((e) => console.error(`[nest_headless] watch ${entityId} crashed:`, e.message));
  }
});

process.on('SIGTERM', async () => {
  try { const b = await browserPromise; if (b) await b.close(); } catch (e) { /* ok */ }
  process.exit(0);
});
