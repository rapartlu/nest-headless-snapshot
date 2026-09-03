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
const ADDON_VERSION = '1.16.0';

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
const faces = require('./faces');
const catid = require('./catid');
const { PendingStore } = require('./pending');
const diskq = require('./diskq');
const { SegmentTracker } = require('./segments');
const evidence = require('./evidence');

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
  // Classify zones (Hearth #12): named crops with a model each
  // (<camera>__<zone>.onnx in nest_models), e.g. washer_door / dryer_door;
  // state-change events. Activity zones: per-tick change inside the crop,
  // running/idle transitions (a drum turning behind glass).
  watchClassifyZones: parseWatchRois(process.env.WATCH_CLASSIFY_ZONES || ''),
  watchActivityZones: parseWatchRois(process.env.WATCH_ACTIVITY_ZONES || ''),
  activityPct: Number(process.env.ACTIVITY_PCT || 1.5),
  zoneChangeThreshold: Number(process.env.ZONE_CHANGE_THRESHOLD || 10),   // mean grey difference (0-255) on a 48x48 fingerprint
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
  // Shadow recogniser for bake-offs: every utterance is also sent here and the
  // result only logged (SHADOW lines), never used or posted. Empty = off.
  sttShadowUrl: (process.env.STT_SHADOW_URL || '').replace(/\/+$/, ''),
  sttFallbackUrl: (process.env.STT_FALLBACK_URL || '').replace(/\/+$/, ''),   // second server tried when stt_url fails (e.g. Whisper behind Parakeet)
  // Bearer token for the sensitive routes (/listen, /identity, /utterance,
  // /audiodebug) from anywhere but loopback (Hearth #10). API_TOKEN or
  // API_TOKEN_FILE; when neither is set those routes are loopback-only.
  apiToken: (process.env.API_TOKEN || (process.env.API_TOKEN_FILE && (() => { try { return fs.readFileSync(process.env.API_TOKEN_FILE, 'utf8'); } catch (e) { return ''; } })()) || '').trim(),
  // Voice identity: embeddings + enrolments under <config>/nest_models/identity/.
  // Raw enrolment WAVs are kept only when identity_keep_samples is on.
  identityDir: path.join(CONFIG_DIR, 'nest_models/identity'),
  identityKeepSamples: (process.env.IDENTITY_KEEP_SAMPLES || 'false') === 'true',
  // confident room voice matches keep an embedding-only room sample (#16; approved by the household admin 2026-09-03)
  identityAutoSamples: (process.env.IDENTITY_AUTO_SAMPLES || 'true') === 'true',
  // Transcript wake path: every speech segment on a tapped microphone is
  // transcribed (in memory) and kept only if it starts with the wake phrase or
  // falls inside an open conversation window. Off by default.
  wakeByTranscript: (process.env.WAKE_BY_TRANSCRIPT || 'false') === 'true',
  // A brain's labelled training crops (<dir>/<camera>__<zone>/<label>/*.jpg), served read-only with delete for review (#24)
  trainingDir: process.env.TRAINING_DIR || '',
};

// ------------------------------------------------------------ zones file (the app's zone editor)
// <config>/nest_models/zones.json overrides the option strings per camera and
// is what PUT /zones writes. Every zone kind may be a polygon (pts) or a rect.
//   { "version": 1, "cameras": { "kitchen_camera": {
//       "surfaces": [{name, pts|x,y,w,h}], "passages": [{name, pts|x,y,w,h, inside:[x,y]?}],
//       "state": [{name, pts|x,y,w,h}], "activity": [{name, pts|x,y,w,h}] } } }
const ZONES_FILE = path.join(CONFIG_DIR, 'nest_models', 'zones.json');
const ZONE_KINDS = { surfaces: 'watchRois', passages: 'watchPassages', state: 'watchClassifyZones', activity: 'watchActivityZones' };
function zoneFromJson(z, kind) {
  if (!z || typeof z !== 'object' || !/^[a-z0-9_-]{1,32}$/i.test(String(z.name || ''))) throw new Error('bad zone name');
  const f = (v) => { const n = Number(v); if (!Number.isFinite(n) || n < -0.5 || n > 1.5) throw new Error(`bad coordinate in ${z.name}`); return n; };
  let out;
  if (Array.isArray(z.pts)) {
    const pts = z.pts.map((p) => [f(p[0]), f(p[1])]);
    if (pts.length < 3) throw new Error(`${z.name}: a polygon needs 3 points`);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    out = { name: z.name, pts, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, centroid: [xs.reduce((a, b) => a + b, 0) / xs.length, ys.reduce((a, b) => a + b, 0) / ys.length] };
  } else {
    out = { name: z.name, x: f(z.x), y: f(z.y), w: f(z.w), h: f(z.h) };
    if (!(out.w > 0 && out.h > 0)) throw new Error(`${z.name}: empty rect`);
    out.centroid = [out.x + out.w / 2, out.y + out.h / 2];
  }
  if (kind === 'passages') {
    out.inside = Array.isArray(z.inside) && z.inside.length === 2 ? [f(z.inside[0]), f(z.inside[1])] : null;
    if (!out.pts) out.pts = [[out.x, out.y], [out.x + out.w, out.y], [out.x + out.w, out.y + out.h], [out.x, out.y + out.h]];   // the tracker needs a polygon
    // look: {camera, delay_ms?, until_ms?, every_ms?, min_face_px?} - after a
    // crossing, take frames from this camera (where the person appears
    // larger) from delay_ms to until_ms, every every_ms, stopping at the
    // first face big enough to identify; one report against the track (#7)
    if (z.look && typeof z.look === 'object' && /^[a-z0-9_.-]{1,64}$/i.test(String(z.look.camera || ''))) {
      const delay = Math.max(300, Math.min(8000, Number(z.look.delay_ms) || 1500));
      out.look = { camera: cameraEntity(String(z.look.camera)), delay_ms: delay,
        until_ms: Math.max(delay, Math.min(8000, Number(z.look.until_ms) || delay)),
        every_ms: Math.max(500, Math.min(4000, Number(z.look.every_ms) || 1000)),
        min_face_px: Math.max(40, Math.min(200, Number(z.look.min_face_px) || 60)) };
    } else out.look = null;
  }
  if (typeof z.description === 'string' && z.description.trim()) out.description = z.description.trim().slice(0, 160);   // for the brain ("the sideboard by the window")
  return out;
}
function zoneToJson(z, kind) {
  const o = { name: z.name };
  if (z.pts) o.pts = z.pts.map((p) => [Math.round(p[0] * 10000) / 10000, Math.round(p[1] * 10000) / 10000]);
  else { o.x = z.x; o.y = z.y; o.w = z.w; o.h = z.h; }
  if (kind === 'passages') { o.inside = z.inside || null; if (z.look) o.look = { ...z.look, camera: z.look.camera.replace(/^camera\./, '') }; }
  if (z.description) o.description = z.description;
  return o;
}
function zonesToJson() {
  const cams = {};
  const names = new Set();
  for (const key of Object.values(ZONE_KINDS)) for (const cam of Object.keys(cfg[key] || {})) names.add(cam);
  for (const cam of names) {
    cams[cam.replace(/^camera\./, '')] = Object.fromEntries(Object.entries(ZONE_KINDS).map(([kind, key]) => [kind, (cfg[key][cam] || []).map((z) => zoneToJson(z, kind))]));
  }
  return { version: 1, frame: { w: 1920, h: 1080 }, cameras: cams, file: fs.existsSync(ZONES_FILE) ? ZONES_FILE : null };
}
function loadZonesFile() {
  let j;
  try { j = JSON.parse(fs.readFileSync(ZONES_FILE, 'utf8')); } catch (e) { return false; }
  for (const [camName, kinds] of Object.entries(j.cameras || {})) {
    const cam = 'camera.' + camName.replace(/^camera\./, '');
    for (const [kind, key] of Object.entries(ZONE_KINDS)) {
      if (!Array.isArray(kinds[kind])) continue;
      const parsed = kinds[kind].map((z) => zoneFromJson(z, kind));
      if (parsed.length) cfg[key][cam] = parsed; else delete cfg[key][cam];
    }
  }
  console.log(`[nest_headless] zones loaded from ${ZONES_FILE}`);
  return true;
}
function saveZonesFile(cams) {
  fs.mkdirSync(path.dirname(ZONES_FILE), { recursive: true });
  const current = (() => { try { return JSON.parse(fs.readFileSync(ZONES_FILE, 'utf8')); } catch (e) { return { version: 1, cameras: {} }; } })();
  // start from the live config so cameras the file has never seen keep their option-string zones
  const live = zonesToJson().cameras;
  const merged = { version: 1, updated_at: new Date().toISOString(), cameras: { ...live, ...(current.cameras || {}), ...cams } };
  fs.writeFileSync(ZONES_FILE + '.tmp', JSON.stringify(merged, null, 2));
  fs.renameSync(ZONES_FILE + '.tmp', ZONES_FILE);
}
loadZonesFile();

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
    await diskq.writeAtomic(file, buf);   // async: www/ may be a network share (#17)
    let cropFile = null;
    let verdict = null;
    if (shot.cropDataUrl) {
      cropFile = file.replace(/\.jpg$/, '_crop.jpg');
      const cbuf = Buffer.from(shot.cropDataUrl.split(',')[1], 'base64');
      await diskq.writeAtomic(cropFile, cbuf);
      verdict = classify(entityId, cbuf); // linear model: verdict + framing gate
      // The fine-tuned CNN (hot-loaded onnx) outranks the linear verdict when
      // present; the linear model's framing gate still applies on top.
      if (infer.hasDoorModel(entityId)) {
        const cnn = await infer.classifyDoor(entityId, cbuf).catch((e) => {
          console.warn(`[nest_headless] onnx classify ${entityId} failed: ${e.message}`); return null;
        });
        if (cnn) {
          // The CNN's verdict stands on its own: a WIDE-open door occludes
          // the linear model's reference region and tanks refCorr, so the
          // framing veto muted the exact state this classifier exists to
          // catch (score 1.00 suppressed for over an hour on 2026-08-31).
          // The linear reference also predates the laser-slice crop, so its
          // framingOk is stale noise here (Hearth #8): not reported.
          verdict = { ...cnn, positive: cnn.positive };
        }
      }
      // Explicit health for consumers (Hearth #8): ok | dark | framing_drift
      // (framing_drift only means something for the linear engine's gate).
      if (verdict) {
        verdict.state = shot.meanLuma < 3 ? 'dark' : (verdict.engine !== 'onnx' && verdict.framingOk === false ? 'framing_drift' : 'ok');
        const prev = classifierState[entityId];
        if (prev !== verdict.state) {
          classifierState[entityId] = verdict.state;
          if (prev !== undefined) {
            console.log(`[nest_headless] classifier state ${entityId}: ${prev} -> ${verdict.state}`);
            postHaEvent('nest_headless_health', { entity_id: entityId, camera: entityId.replace(/^camera\./, ''), classifier_state: verdict.state, previous: prev }).catch(() => {});
          }
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
        sampleIndex(entityId).put(stamped.replace(/\.jpg$/, '_f.jpg'), buf).catch(() => { /* crop archive still stands */ });
      }
      const entry = { t: new Date().toISOString(), img: stamped, luma: meta.meanLuma };
      if (verdict) entry.classifier = verdict;
      if (!cropFile) {
        // full-frame camera: enrich the timeline with detections + boxes
        try {
          const { cat, dets } = await catOnSurface(entityId, buf);
          entry.cat = cat;
          entry.dets = (dets || []).map((d) => ({ name: d.name, conf: d.conf, roi: d.roi }));
          const aname = stamped.replace(/\.jpg$/, '_a.jpg');
          infer.annotate(buf, dets || [], cfg.watchRois[entityId] || []).then((boxed) => sampleIndex(entityId).put(aname, boxed)).catch(() => {});
          entry.aimg = aname;
        } catch (e) { /* timeline entry stays un-annotated */ }
      }
      appendTimeline(entityId, entry);
    }
  }
  return { buf, meta };
}

// Archive directories: the listing is read once and kept in memory, and every
// write is queued per directory. On a network share a sync readdir of a
// 2000-file archive took 2.6 s and stalled audio and the status route (#17).
const dirIndexes = new Map();
function sampleIndex(entityId, suffix = '') {
  const dir = path.join(cfg.samplesDir, entityId.replace(/^camera\./, '') + suffix);
  if (!dirIndexes.has(dir)) dirIndexes.set(dir, new diskq.DirIndex(dir));
  return dirIndexes.get(dir);
}
// ---- evidence by reference (#21): every frame node handles goes into a
// per-camera memory ring (exact frames for the last minute or two); frames
// behind events are also written to <camera>_events/ in the archive, and
// GET /archive/<camera>/<time>.jpg answers with the nearest of either.
const frameRings = {};
function noteFrame(entityId, jpg, t = Date.now()) {
  (frameRings[entityId] || (frameRings[entityId] = new evidence.FrameRing(90))).push(t, jpg);
  return t;
}
function keepEventFrame(entityId, t, jpg) {
  if (!cfg.samplesDir || !jpg) return;
  sampleIndex(entityId, '_events').put(evidence.stampOf(t) + '.jpg', jpg, { max: 600, dropN: 60 }).catch(() => {});
}
// nearest frame to t: memory ring, then the event archive, then the heartbeat archive
async function frameNear(entityId, t, withinMs) {
  const cands = [];
  const r = frameRings[entityId] && frameRings[entityId].nearest(t);
  if (r) cands.push({ dt: r.dt, t: r.t, source: 'memory', jpg: r.jpg });
  if (cfg.samplesDir) {
    for (const [suffix, source] of [['_events', 'events'], ['', 'archive']]) {
      const ix = sampleIndex(entityId, suffix);
      const n = evidence.nearestName(await ix.load(), t);
      if (n) cands.push({ dt: n.dt, t: n.t, source, file: path.join(ix.dir, n.name) });
    }
  }
  const best = cands.sort((a, b) => a.dt - b.dt)[0];
  if (!best || best.dt > withinMs) return null;
  if (!best.jpg) best.jpg = await require('fs/promises').readFile(best.file);
  return best;
}
const boxOf = (b) => ({ x: r4(b.x), y: r4(b.y), w: r4(b.w), h: r4(b.h) });
const lastArchiveMs = {};
function archiveSample(entityId, buf) {
  // keep the training archive at a sane cadence however often frames flow
  const now = Date.now();
  if (now - (lastArchiveMs[entityId] || 0) < cfg.sampleArchiveSeconds * 1000 - 2000) return null;
  lastArchiveMs[entityId] = now;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // cap the archive: drop the oldest tenth when full
  sampleIndex(entityId).put(stamp + '.jpg', buf, { max: cfg.samplesMax, dropN: Math.ceil(cfg.samplesMax / 10) })
    .catch((e) => console.warn('[nest_headless] sample archive failed:', e.message));
  return stamp + '.jpg';
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
    const f = path.join(dir, 'timeline.json');
    let arr = timelineCache[cam];
    if (!arr) { try { arr = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { arr = []; } }
    arr.unshift(entry);
    if (arr.length > 300) arr = arr.slice(0, 300);
    timelineCache[cam] = arr;
    diskq.writeAtomic(f, Buffer.from(JSON.stringify(arr))).catch((e) => console.warn('[nest_headless] timeline write failed:', e.message));
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
const classifierState = {}; // entityId -> 'ok' | 'dark' | 'framing_drift' (last reported, for nest_headless_health)
// Event-loop lag, measured every 500 ms. When the loop lags, the optional
// vision work (passage detection, zone ticks, face sampling, backlog
// candidates) yields for that tick so the status route and the audio path
// stay responsive (Hearth #17: a 20-minute 100% spin during an onboarding
// burst made `/` take 1.5 s and the house go deaf).
const LAG_SKIP_MS = 400;
let loopLagMs = 0, lastLagWarnMs = 0;
{
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    loopLagMs = Math.max(0, now - last - 500); last = now;
    if (loopLagMs > LAG_SKIP_MS && now - lastLagWarnMs > 30000) { lastLagWarnMs = now; console.warn(`[nest_headless] event loop lagging ${loopLagMs} ms - optional vision work yields`); }
  }, 500).unref();
}
function loopBusy() { return loopLagMs > LAG_SKIP_MS; }

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
  if (!passages.length || loopBusy()) return;
  if (now - (mgr.lastPassageMs || 0) < 700) return;
  mgr.lastPassageMs = now;
  try {
    const d = await infer.detect(frameBuf, { conf: 0.4, classes: [0, 24, 26, 28] });   // person, backpack, handbag, suitcase
    if (d === null) return;
    const persons = d.filter((x) => x.cls === 0), bags = d.filter((x) => x.cls !== 0);
    mgr.tracker = mgr.tracker || new PassageTracker(entityId, passages);
    const events = mgr.tracker.update(persons, bags, now);
    if (!events.length) return;
    // who: faces in this frame whose centre lies inside the crossing person's box (1.10.0)
    let seen = [];
    if (faces.hasModels(FACE_MODELS_DIR())) {
      try {
        const found = await faces.facesInJpeg(FACE_MODELS_DIR(), frameBuf, { minPx: 40 });
        considerFacesForPending(entityId, frameBuf, found).catch(() => {});
        // every face, matched or not (#7): a doorway face seen from down the
        // hall is often under the 60 px identification floor - the brain
        // still wants to know a face was there and how big
        seen = (found || []).map(faceSummary);
      } catch (e) { /* faces are a bonus */ }
    }
    for (const ev of events) {
      const t = mgr.tracker.tracks.find((x) => x.id === ev.track_id);
      const inBox = (f) => t && f.box.x + f.box.w / 2 > t.box.x && f.box.x + f.box.w / 2 < t.box.x + t.box.w && f.box.y + f.box.h / 2 > t.box.y && f.box.y + f.box.h / 2 < t.box.y + t.box.h;
      const face = seen.find(inBox) || (seen.length === 1 && persons.length === 1 ? seen[0] : null);
      if (face) ev.person = { ...ev.person, matches: face.matches, name: face.name, score: face.score, size_px: face.size_px };
      ev.faces = seen;
      // evidence (#21): the frame this came from, and the boxes on it
      const zone = passages.find((p) => p.name === ev.passage);
      ev.frame_at = new Date(now).toISOString();
      ev.boxes = [
        ...(zone ? [{ label: 'passage:' + zone.name, ...boxOf(zone) }] : []),
        ...(t ? [{ label: 'person', track_id: ev.track_id, ...boxOf(t.box) }] : []),
        ...seen.map((f) => ({ label: 'face', name: f.name, score: f.score, size_px: f.size_px, ...boxOf(f.box) })),
      ];
      keepEventFrame(entityId, now, frameBuf);
      console.log(`[nest_headless] PASSAGE ${ev.direction} ${ev.passage} on ${entityId} track ${ev.track_id} h=${ev.attributes.height_ratio} carrying=${ev.attributes.carrying} who=${ev.person.matches[0] ? ev.person.matches[0].name + ':' + ev.person.matches[0].score : '-'} faces=${seen.length}`);
      postHaEvent('nest_headless_passage', { entity_id: entityId, camera: entityId.replace(/^camera\./, ''), ...ev }).catch(() => {});
      scheduleSecondLook(entityId, ev, passages.find((p) => p.name === ev.passage));
    }
  } catch (e) { console.warn(`[nest_headless] passage tick ${entityId} failed: ${e.message}`); }
}

// A face as the brain sees it on passage events: box, size, detector score,
// the top matches when it was large enough to embed, and the name at >= 0.4.
function faceSummary(f) {
  const m = f.matches || (f.embedding ? matchFace(f.embedding) : []);
  return { box: f.box, size_px: f.quality.size_px, det_score: f.quality.det_score, matches: m,
    name: m[0] && m[0].score >= 0.4 ? m[0].name : null, score: m[0] ? m[0].score : null };
}
// Second look (#7): a passage may name a camera to look from after a
// crossing (`look: {camera, delay_ms}` in zones.json) - the person appears
// larger there a moment later. Its faces go out as nest_headless_passage_look
// against the same track id so the brain can stitch the two.
function scheduleSecondLook(fromEntity, ev, zone) {
  if (!zone || !zone.look || !faces.hasModels(FACE_MODELS_DIR())) return;
  const { camera, delay_ms, until_ms, every_ms, min_face_px } = zone.look;
  const t0 = Date.now();
  (async () => {
    // A series, not one frame: at 1.5 s the person is still by the door and
    // the face is ~30 px; it reaches the identification floor a few seconds
    // in. Frames are the held stream's own (no vendor command). Stop at the
    // first face large enough to embed; otherwise report the largest seen.
    let attempts = 0, bestEmbedded = null, largest = null, lastList = [], lastReason = null, atMs = delay_ms, lastAt = null;
    try {
      for (let t = delay_ms; t <= until_ms; t += every_ms) {
        await sleep(Math.max(0, t0 + t - Date.now()));
        attempts++;
        const r = await facesForCamera(camera);
        lastReason = r.ok ? null : (r.reason || 'no_frame');
        lastAt = r.at || Date.now();
        lastList = (r.faces || []).map(faceSummary);
        for (const f of lastList) if (!largest || f.size_px > largest.size_px) largest = f;
        const embedded = lastList.filter((f) => f.matches.length && f.size_px >= min_face_px).sort((a, b) => b.score - a.score)[0];
        if (embedded) { bestEmbedded = embedded; atMs = t; keepEventFrame(camera, lastAt, r.jpg); break; }
        atMs = t;
      }
      const best = bestEmbedded;
      const reason = best ? null : (largest ? 'face_too_small' : (lastReason || 'no_face'));
      console.log(`[nest_headless] PASSAGE look ${ev.passage} from ${camera} for track ${ev.track_id}: ${attempts} frame(s) to ${atMs} ms, ${best ? 'best ' + (best.name || '?') + ':' + best.score + ' ' + best.size_px + 'px' : (largest ? 'largest face ' + largest.size_px + 'px, ' + reason : reason)}`);
      postHaEvent('nest_headless_passage_look', {
        entity_id: camera, camera: camera.replace(/^camera\./, ''), from_camera: fromEntity.replace(/^camera\./, ''),
        passage: ev.passage, direction: ev.direction, track_id: ev.track_id,
        delay_ms, until_ms, every_ms, min_face_px, attempts, at_ms: atMs, ok: !!best, reason,
        frame_at: lastAt ? new Date(lastAt).toISOString() : null,
        boxes: (best ? lastList : (largest ? [largest] : lastList)).map((f) => ({ label: 'face', name: f.name, score: f.score, size_px: f.size_px, ...boxOf(f.box) })),
        faces: best ? lastList : (largest ? [largest] : lastList),
        person: best ? { name: best.name, score: best.score, size_px: best.size_px, matches: best.matches } : null,
      }).catch(() => {});
    } catch (e) { console.warn(`[nest_headless] passage look ${camera} failed: ${e.message}`); }
  })();
}

// ------------------------------------------------------------ state zones (Hearth #12, #13)
// The senses/intelligence split: the add-on notices THAT a zone's content
// changed (a door swung open, a fridge door, a drawer) and hands the brain
// the before/after crops plus who was nearby; the brain decides what it
// means (open/closed, what was taken). No per-appliance training needed.
// A zone is compared against a reference crop taken when it was last steady
// for STEADY_TICKS; a sustained difference (CHANGE_TICKS ticks above
// zoneChangeThreshold) posts nest_headless_zone_change and, once the new
// look has held for STEADY_TICKS, becomes the new reference.
// If a trained model exists for the zone (<camera>__<zone>.onnx, classes
// closed/open) the same tick also runs it and posts nest_headless_zone_state
// on debounced flips - an optional accelerator, e.g. the cupboard door.
const ZONE_TICK_MS = 2000, ZONE_DEBOUNCE_TICKS = 2, STEADY_TICKS = 3, CHANGE_TICKS = 2, ZONE_CHANGE_THRESHOLD = 10;
let sharpMod = null;
function getSharp() { if (sharpMod === null) { try { sharpMod = require('sharp'); } catch (e) { sharpMod = false; } } return sharpMod; }
const FP = 48; // fingerprint side
// Polygon zones: a 48x48 mask over the bounding rect so the change test only
// looks inside the drawn shape (cached on the zone object).
function zoneMask(z) {
  if (!z.pts) return null;
  if (z.mask48) return z.mask48;
  const m = new Uint8Array(FP * FP);
  const inPoly = (px, py) => { let inside = false; for (let i = 0, j = z.pts.length - 1; i < z.pts.length; j = i++) { const [xi, yi] = z.pts[i], [xj, yj] = z.pts[j]; if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside; } return inside; };
  for (let y = 0; y < FP; y++) for (let x = 0; x < FP; x++) if (inPoly(z.x + (x + 0.5) / FP * z.w, z.y + (y + 0.5) / FP * z.h)) m[y * FP + x] = 1;
  z.mask48 = m;
  return m;
}
// before | after crops side by side (same height), for the app's evidence view (#21)
async function zonePairComposite(sharp, before, after) {
  const [a, b] = await Promise.all([sharp(before).metadata(), sharp(after).metadata()]);
  const h = Math.min(a.height, b.height, 480);
  const [ab, bb] = await Promise.all([sharp(before).resize({ height: h }).toBuffer({ resolveWithObject: true }), sharp(after).resize({ height: h }).toBuffer({ resolveWithObject: true })]);
  const gap = 6;
  return sharp({ create: { width: ab.info.width + gap + bb.info.width, height: h, channels: 3, background: { r: 255, g: 210, b: 0 } } })
    .composite([{ input: ab.data, left: 0, top: 0 }, { input: bb.data, left: ab.info.width + gap, top: 0 }]).jpeg({ quality: 88 }).toBuffer();
}
async function zoneCrops(sharp, jpg, W, H, z) {
  const left = Math.max(0, Math.round(z.x * W)), top = Math.max(0, Math.round(z.y * H));
  const width = Math.max(8, Math.min(W - left, Math.round(z.w * W))), height = Math.max(8, Math.min(H - top, Math.round(z.h * H)));
  const base = sharp(jpg).extract({ left, top, width, height });
  const [jpeg, grey] = await Promise.all([
    base.clone().jpeg({ quality: 88 }).toBuffer(),
    base.clone().resize(FP, FP, { fit: 'fill' }).greyscale().raw().toBuffer(),   // fingerprint for the change test
  ]);
  return { jpeg, grey, mask: zoneMask(z), rect: { x: left / W, y: top / H, w: width / W, h: height / H } };
}
function greyDiff(a, b, mask) {
  if (!a || !b || a.length !== b.length) return 0;
  let s = 0, n = 0;
  for (let i = 0; i < a.length; i++) { if (mask && !mask[i]) continue; s += Math.abs(a[i] - b[i]); n++; }
  return n ? s / n : 0;
}
async function peopleNear(entityId, jpg, rect) {
  // person boxes overlapping the zone grown by half its size each way, with face matches when a face sits in the box
  try {
    const d = await infer.detect(jpg, { conf: 0.4, classes: [0] });
    if (!d) return [];
    const gx = rect.x - rect.w / 2, gy = rect.y - rect.h / 2, gw = rect.w * 2, gh = rect.h * 2;
    const near = d.filter((p) => p.box.x < gx + gw && p.box.x + p.box.w > gx && p.box.y < gy + gh && p.box.y + p.box.h > gy);
    if (!near.length) return [];
    let seen = [];
    if (faces.hasModels(FACE_MODELS_DIR())) {
      const found = await faces.facesInJpeg(FACE_MODELS_DIR(), jpg, { minPx: 40 }).catch(() => null);
      considerFacesForPending(entityId, jpg, found).catch(() => {});
      seen = (found || []).filter((f) => f.embedding).map((f) => ({ box: f.box, matches: matchFace(f.embedding) }));
    }
    return near.map((p) => {
      const face = seen.find((f) => f.box.x + f.box.w / 2 > p.box.x && f.box.x + f.box.w / 2 < p.box.x + p.box.w && f.box.y + f.box.h / 2 > p.box.y && f.box.y + f.box.h / 2 < p.box.y + p.box.h);
      const top = face && face.matches[0] && face.matches[0].score >= 0.4 ? face.matches[0] : null;
      return { box: { x: r4(p.box.x), y: r4(p.box.y), w: r4(p.box.w), h: r4(p.box.h) }, height_ratio: Math.round(p.box.h * 100) / 100, name: top ? top.name : null, score: top ? top.score : null, matches: face ? face.matches : [] };
    });
  } catch (e) { return []; }
}
const ZONE_MODEL_MIN_LOO = 0.8;   // a zone model announces state only from this leave-one-out accuracy up
async function zoneClassifyTick(entityId, mgr) {
  const zones = cfg.watchClassifyZones[entityId] || [];
  if (!zones.length || !mgr.page || !mgr.ready || loopBusy()) return;
  const sharp = getSharp(); if (!sharp) return;
  const shot = await mgr.page.evaluate(fns.grabFrame, { quality: cfg.jpegQuality, crop: null });
  if (!shot || shot.meanLuma < 3) return;
  const jpg = Buffer.from(shot.dataUrl.split(',')[1], 'base64');
  const W = shot.width, H = shot.height, now = Date.now();
  noteFrame(entityId, jpg, now);   // evidence ring (#21)
  mgr.zones = mgr.zones || {};
  for (const z of zones) {
    const st = mgr.zones[z.name] || (mgr.zones[z.name] = { state: null, score: null, ticks: [], since: null, model: false, ref: null, refJpeg: null, refSince: null, steady: 0, changed: 0, lastChangeMs: 0, diff: 0 });
    const c = await zoneCrops(sharp, jpg, W, H, z);
    // --- change detection against the reference look
    if (!st.ref) { st.steady++; if (st.steady >= STEADY_TICKS) { st.ref = c.grey; st.refJpeg = c.jpeg; st.refSince = now; } st.last = c.grey; continue; }
    st.diff = Math.round(greyDiff(c.grey, st.ref, c.mask) * 10) / 10;
    const settled = greyDiff(c.grey, st.last, c.mask) < ZONE_CHANGE_THRESHOLD / 2;   // not mid-motion
    st.last = c.grey;
    if (st.diff >= cfg.zoneChangeThreshold) {
      st.changed++; st.steady = 0;
      if (st.changed === CHANGE_TICKS) {
        const people = await peopleNear(entityId, jpg, c.rect);
        const recent = (mgr.recentNames || []).filter((r) => now - r.t < 60000).map((r) => r.name);
        console.log(`[nest_headless] ZONE CHANGE ${z.name} on ${entityId}: diff ${st.diff} vs reference held ${Math.round((now - st.refSince) / 1000)}s; people ${people.length}${people.some((p) => p.name) ? ' (' + people.filter((p) => p.name).map((p) => p.name).join(',') + ')' : ''}`);
        // evidence (#21): the frame, the boxes, and a before|after composite
        // kept under <camera>_zones/<zone>/ for GET /look/zones/...
        keepEventFrame(entityId, now, jpg);
        let lookUrl = null;
        if (cfg.samplesDir) {
          lookUrl = `/look/zones/${entityId.replace(/^camera\./, '')}/${z.name}/${evidence.stampOf(now)}.jpg`;
          zonePairComposite(sharp, st.refJpeg, c.jpeg)
            .then((buf) => sampleIndex(entityId, '_zones/' + z.name).put(evidence.stampOf(now) + '.jpg', buf, { max: 200, dropN: 20 }))
            .catch((e) => console.warn(`[nest_headless] zone pair ${z.name} failed: ${e.message}`));
        }
        postHaEvent('nest_headless_zone_change', {
          entity_id: entityId, camera: entityId.replace(/^camera\./, ''), zone: z.name, t: new Date(now).toISOString(),
          diff: st.diff, reference_held_s: Math.round((now - st.refSince) / 1000),
          before_jpeg_b64: st.refJpeg.toString('base64'), after_jpeg_b64: c.jpeg.toString('base64'),
          people_nearby: people, recent_names: [...new Set(recent)],
          frame_at: new Date(now).toISOString(), look_url: lookUrl,
          // the trained model's current view of this zone, when one exists (#22)
          model: st.model ? { state: st.state, score: st.score, engine: st.engine, ...(st.modelMeta || {}) } : null,
          boxes: [{ label: 'zone:' + z.name, ...boxOf(c.rect) }, ...people.map((p) => ({ label: 'person', name: p.name, score: p.score, ...boxOf(p.box) }))],
        }).catch(() => {});
        st.lastChangeMs = now;
      }
      // adopt the new look once it has held still for STEADY_TICKS after the change
      if (st.changed > CHANGE_TICKS && settled) { st.hold = (st.hold || 0) + 1; if (st.hold >= STEADY_TICKS) { st.ref = c.grey; st.refJpeg = c.jpeg; st.refSince = now; st.changed = 0; st.hold = 0; } } else st.hold = 0;
    } else { st.changed = 0; st.hold = 0; st.steady++; if (settled && st.steady >= STEADY_TICKS * 5) { st.ref = c.grey; st.refJpeg = c.jpeg; } }   // slow drift (lighting) refresh
    // --- optional trained state model
    // <camera>__<zone>.onnx (a CNN) outranks <camera>__<zone>.json (the linear
    // template matcher from tools/train_door_model.py, retrained by
    // tools/retrain_zones.py as labels grow, #22); both hot-load on change
    const key = `${entityId}__${z.name}`;
    let v = null;
    if (infer.hasDoorModel(key)) v = await infer.classifyDoor(key, c.jpeg, { label: z.name, threshold: 0.5 });
    else { const lin = classify(key, c.jpeg); if (lin) v = { ...lin, engine: 'linear' }; }
    if (!v) { st.model = false; continue; }
    st.engine = v.engine || 'onnx'; st.modelMeta = { trained: v.trained || null, samples: v.samples || null, loo_acc: v.loo_acc == null ? null : v.loo_acc, holdout_acc: v.holdout_acc == null ? null : v.holdout_acc };
    st.model = true; st.score = v.score; st.ticks.push(v.positive ? 1 : 0);
    while (st.ticks.length > ZONE_DEBOUNCE_TICKS) st.ticks.shift();
    const sum = st.ticks.reduce((a, b) => a + b, 0);
    let next = st.state;
    if (st.ticks.length >= ZONE_DEBOUNCE_TICKS) { if (sum === ZONE_DEBOUNCE_TICKS) next = 'open'; else if (sum === 0) next = 'closed'; }
    if (next && next !== st.state) {
      const prev = st.state;
      const prevDuration = st.since ? Math.round((now - st.since) / 1000) : null;
      st.state = next; st.since = now;
      // A model that scored under ZONE_MODEL_MIN_LOO on its own training frames
      // keeps its view on zone_change (`model`) but does not announce state
      // flips: a coin-flip verdict is noise, not a sense (#22).
      const trusted = !(st.modelMeta && st.modelMeta.loo_acc != null && st.modelMeta.loo_acc < ZONE_MODEL_MIN_LOO);
      console.log(`[nest_headless] ZONE ${z.name} on ${entityId}: ${prev || 'unknown'} -> ${next} (score ${v.score}${trusted ? '' : ', model below trust floor - not announced'})`);
      if (prev && trusted) {
        const people = await peopleNear(entityId, jpg, c.rect);
        postHaEvent('nest_headless_zone_state', {
          entity_id: entityId, camera: entityId.replace(/^camera\./, ''), zone: z.name, label: z.name,
          state: next, previous: prev, score: v.score, previous_duration_s: prevDuration, t: new Date(now).toISOString(), people_nearby: people,
          model: true, engine: st.engine, ...st.modelMeta,   // loo_acc: leave-one-out accuracy over the originals it was trained on - trust it from ~0.9 up
          frame_at: new Date(now).toISOString(),
          boxes: [{ label: 'zone:' + z.name, ...boxOf(c.rect) }, ...people.map((p) => ({ label: 'person', name: p.name, score: p.score, ...boxOf(p.box) }))],
        }).catch(() => {});
        keepEventFrame(entityId, now, jpg);
      }
    }
  }
}
// Activity zones: the page reports per-tick change % inside each zone; a
// rolling window (20 ticks) decides running/idle with hysteresis (>= 60% of
// ticks above activity_pct to start, < 20% to stop).
const activityState = {}; // entityId -> zone -> { window, state, since, lastMean }
function onActivity(entityId, pcts) {
  const zones = cfg.watchActivityZones[entityId] || [];
  const st = activityState[entityId] || (activityState[entityId] = {});
  for (const z of zones) {
    const pct = Number(pcts && pcts[z.name]);
    if (!Number.isFinite(pct)) continue;
    const a = st[z.name] || (st[z.name] = { window: [], state: 'idle', since: Date.now(), lastMean: 0 });
    a.window.push(pct); while (a.window.length > 20) a.window.shift();
    a.lastMean = Math.round(a.window.reduce((x, y) => x + y, 0) / a.window.length * 10) / 10;
    if (a.window.length < 10) continue;
    const above = a.window.filter((p) => p >= cfg.activityPct).length / a.window.length;
    const next = a.state === 'running' ? (above < 0.2 ? 'idle' : 'running') : (above >= 0.6 ? 'running' : 'idle');
    if (next === a.state) continue;
    if (next === 'running') {
      // A person loading the machine moves over the porthole and reads as a
      // turning drum (three 19-84 s "cycles" on 3 Sept, each with someone at
      // the appliance). Before going running, check a fresh frame for a
      // person box covering >= 25% of the zone; if so hold idle and try again
      // on the next tick - a real cycle keeps turning after they leave.
      if (a.checking) continue;
      a.checking = true;
      occludedBy(entityId, z).then((who) => {
        a.checking = false;
        if (who) { a.window.length = 0; if (Date.now() - (a.lastOccludedLogMs || 0) > 60000) { a.lastOccludedLogMs = Date.now(); console.log(`[nest_headless] ACTIVITY ${z.name} on ${entityId}: motion but occluded by a person (${Math.round(who.overlap * 100)}% of the zone) - staying idle`); } return; }
        activityTransition(entityId, z, a, 'running');
      }).catch(() => { a.checking = false; });
      continue;
    }
    activityTransition(entityId, z, a, next);
  }
}
function activityTransition(entityId, z, a, next) {
  const now = Date.now(), prev = a.state, dur = Math.round((now - a.since) / 1000);
  a.state = next; a.since = now;
  console.log(`[nest_headless] ACTIVITY ${z.name} on ${entityId}: ${prev} -> ${next} after ${dur}s (mean ${a.lastMean}%)`);
  postHaEvent('nest_headless_activity', {
    entity_id: entityId, camera: entityId.replace(/^camera\./, ''), zone: z.name,
    state: next, previous: prev, previous_duration_s: dur, mean_pct: a.lastMean, t: new Date(now).toISOString(),
  }).catch(() => {});
}
// Fraction of a zone's bounding rect covered by the largest overlapping person box, on a fresh frame.
async function occludedBy(entityId, z) {
  const mgr = watchMgr[entityId];
  if (!mgr || !mgr.page || !mgr.ready) return null;
  const shot = await mgr.page.evaluate(fns.grabFrame, { quality: cfg.jpegQuality, crop: null });
  const jpg = Buffer.from(shot.dataUrl.split(',')[1], 'base64');
  const d = await infer.detect(jpg, { conf: 0.4, classes: [0] });
  if (!d || !d.length) return null;
  let best = 0;
  for (const p of d) {
    const ix = Math.max(0, Math.min(z.x + z.w, p.box.x + p.box.w) - Math.max(z.x, p.box.x));
    const iy = Math.max(0, Math.min(z.y + z.h, p.box.y + p.box.h) - Math.max(z.y, p.box.y));
    best = Math.max(best, (ix * iy) / (z.w * z.h || 1));
  }
  return best >= 0.25 ? { overlap: best } : null;
}

async function watchHit(entityId, payload) {
  const mgr = watchMgr[entityId];
  if (!mgr) return;
  const now = Date.now();
  // Stream-settle grace: a freshly (re)connected stream shifts exposure and
  // resolution for its first seconds, which diffs like motion (fired a
  // phantom deterrent 6s after a restart). Ignore hits until it settles.
  if (now - (mgr.readySinceMs || 0) < 45000) return;
  const hitFrame = Buffer.from(payload.dataUrl.split(',')[1], 'base64');
  if (payload.meanLuma >= 3) noteFrame(entityId, hitFrame, now);   // evidence ring (#21)
  if ((cfg.watchPassages[entityId] || []).length && payload.meanLuma >= 3) {
    passageTick(entityId, mgr, hitFrame, now).catch(() => {});
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
  // which cat (#23): describe and match every cat box; ambiguous ones go to the backlog
  let catsSeen = [];
  if (dets && dets.some((x) => x.cls === 15 || x.cls === 16)) catsSeen = await identifyCats(entityId, frameBuf, dets).catch(() => []);
  const whoOf = (x) => { const c = catsSeen.find((k) => k.box === x.box); return c ? { name: c.name, score: c.score, matches: c.matches, size_px: c.quality.size_px } : null; };
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
  keepEventFrame(entityId, now, frameBuf);
  const roiZone = (cfg.watchRois[entityId] || []).find((r) => r.name === payload.roi);
  await postHaEvent('nest_headless_surface_activity', {
    entity_id: entityId,
    camera: entityId.replace(/^camera\./, ''),
    roi: payload.roi,
    changed_pct: payload.changedPct,
    cat: verdict,
    detections: dets ? dets.slice(0, 5).map((x) => ({ ...x, who: whoOf(x) })) : null,
    // which cat (#23): the best-identified cat in the frame; `cat` above stays the boolean verdict
    who: (() => { const best = catsSeen.filter((c) => c.name).sort((a, b) => b.score - a.score)[0]; return best ? { name: best.name, score: best.score, matches: best.matches, size_px: best.quality.size_px } : (catsSeen[0] ? { name: null, score: catsSeen[0].score, matches: catsSeen[0].matches, size_px: catsSeen[0].quality.size_px } : null); })(),
    people: await countPeople(frameBuf),
    frame_at: new Date(now).toISOString(),
    boxes: [
      ...(roiZone ? [{ label: 'surface:' + roiZone.name, ...boxOf(roiZone) }] : []),
      ...(dets || []).slice(0, 8).map((d) => ({ label: d.name, score: d.conf, roi: d.roi || null, ...boxOf(d.box) })),
    ],
  });
}

const lastHitSnapMs = {};
function saveHitSnapshot(entityId, frameBuf, dets, roi) {
  if (!cfg.samplesDir) return;
  const now = Date.now();
  if (now - (lastHitSnapMs[entityId] || 0) < 10000) return;
  lastHitSnapMs[entityId] = now;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  infer.annotate(frameBuf, dets || [], cfg.watchRois[entityId] || [])
    .then((boxed) => sampleIndex(entityId, '_hits').put(`${stamp}_${roi}.jpg`, boxed, { max: 600, dropN: 60 }))
    .catch(() => { /* evidence is best-effort */ });
}

// Keep the evidence: raw + box-annotated copies of every frame that
// confirmed a cat on a surface. The alert notification shows the annotated
// one, so "where was it?" never needs forensics again. Resolves once
// _cat.jpg exists (the alert names it); the archive copy trails.
async function saveCatSnapshot(entityId, frameBuf, dets) {
  try {
    const base = cameraFile(entityId).replace(/\.jpg$/, '');
    const raw = diskq.writeAtomic(base + '_cat_raw.jpg', frameBuf);
    const boxed = await infer.annotate(frameBuf, dets, cfg.watchRois[entityId] || []);
    await diskq.writeAtomic(base + '_cat.jpg', boxed);
    await raw;
    if (cfg.samplesDir) {
      // every cat event archived, no throttle: these are the frames questions
      // get asked about ("where was it? was that really a cat?")
      sampleIndex(entityId, '_cats').put(new Date().toISOString().replace(/[:.]/g, '-') + '.jpg', boxed).catch(() => {});
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
    if (cat) await saveCatSnapshot(entityId, frameBuf, dets);   // the alert names _cat.jpg: it must exist first
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
// enrolledFaces: same shape from identity/<name>/face-*.json (ArcFace 512-d)
let enrolled = null, enrolledFaces = {}, enrolledCats = {};
// In-memory shape of an enrolled sample. source: 'room' (a camera microphone
// or frame) or 'upload' (a phone recording or photo) - older files carry
// only `camera`, so it is derived from that.
function sampleItem(file, j) {
  return { embedding: j.embedding, file, at: j.at, pose: j.pose || null, auto: !!j.auto,
    source: j.source || (String(j.camera || '').startsWith('camera.') ? 'room' : 'upload') };
}
function loadEnrolled() {
  enrolled = {}; enrolledFaces = {}; enrolledCats = {};
  try {
    for (const name of fs.readdirSync(cfg.identityDir)) {
      const d = path.join(cfg.identityDir, name);
      if (name === 'models' || name === 'pending' || name === 'negatives' || !fs.statSync(d).isDirectory()) continue;
      const items = [], fitems = [], citems = [];
      for (const f of fs.readdirSync(d)) {
        const kind = /^(voice|face|cat)-.*\.json$/.exec(f);
        if (!kind) continue;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
          if (Array.isArray(j.embedding)) ({ voice: items, face: fitems, cat: citems })[kind[1]].push({ ...sampleItem(f, j), sized: j.sized !== false });
        } catch (e) { /* skip */ }
      }
      if (items.length) enrolled[name] = items;
      if (fitems.length) enrolledFaces[name] = fitems;
      if (citems.length) enrolledCats[name] = citems;
    }
  } catch (e) { /* no identity dir yet */ }
  return enrolled;
}
const FACE_MODELS_DIR = () => path.join(cfg.identityDir, 'models');
const pending = new PendingStore(path.join(cfg.identityDir, 'pending'));   // verification backlog (#16)
function matchFace(embedding) {
  if (!enrolled) loadEnrolled();
  if (pending.negativeScore('face', embedding, faces.cosine) >= FACE_DECISIVE) return [];   // a known "not a person" (#18)
  const out = [];
  for (const [name, items] of Object.entries(enrolledFaces)) {
    const best = Math.max(...items.map((it) => faces.cosine(embedding, it.embedding)));
    out.push({ name, score: Math.round(best * 1000) / 1000 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}
// ---- cat identity (#23): the same shape as faces, over catid.js descriptors.
// Descriptor cosines run high (a colour histogram dominates), so the naming
// line is 0.9 and "decisive" needs 0.03 clear of the runner-up.
const CAT_NAME_AT = 0.9, CAT_DECISIVE = 0.92, CAT_GAP = 0.03, CAT_MIN_PX = 60;
function matchCat(emb, sized = true) {
  if (!enrolled) loadEnrolled();
  const out = [];
  for (const [name, items] of Object.entries(enrolledCats)) {
    const best = Math.max(...items.map((it) => catid.cosine(emb, it.embedding, sized, it.sized)));
    out.push({ name, score: Math.round(best * 1000) / 1000 });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}
const catAmbiguous = (m) => !m.length || m[0].score < CAT_DECISIVE || !!(m[1] && m[0].score - m[1].score < CAT_GAP);
// Cats in a frame: the house detector's boxes, each described and matched.
// dets may be passed in (the surface pass already ran the detector).
async function catsInJpeg(jpg, { dets = null, camera = null } = {}) {
  const sharp = getSharp();
  if (!sharp) return { ok: false, reason: 'no_sharp', cats: [] };
  const d = dets || await infer.detectCats(jpg, { conf: 0.5 });
  if (d === null) return { ok: false, reason: 'no_detector', cats: [] };
  const out = [];
  for (const x of d.filter((det) => det.cls === 15 || det.cls === 16)) {
    try {
      const desc = await catid.describeInJpeg(sharp, jpg, x.box);
      const usable = desc.size_px >= CAT_MIN_PX;
      const matches = usable ? matchCat(desc.vec, desc.sized) : [];
      const top = matches[0] && matches[0].score >= CAT_NAME_AT ? matches[0] : null;
      out.push({ box: x.box, conf: x.conf, roi: x.roi || null, quality: { size_px: desc.size_px, det_score: x.conf, reason: usable ? 'ok' : 'cat_too_small' },
        name: top ? top.name : null, score: matches[0] ? matches[0].score : null, matches, _emb: usable ? desc.vec : null, _sized: desc.sized, _crop: desc.crop });
    } catch (e) { /* one bad crop */ }
  }
  out.sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h);
  return { ok: true, cats: out, camera };
}
const publicCat = (c) => ({ name: c.name, score: c.score, box: c.box, conf: c.conf, roi: c.roi, quality: c.quality, matches: c.matches });
// Enrol one cat from a frame's detections or an uploaded photo (found = catsInJpeg result, or {photo: desc}).
function enrolCat(name, source, found, index) {
  if (!/^[a-z0-9_-]{1,32}$/i.test(name)) return { ok: false, accepted: false, reason: 'bad_name' };
  name = name.toLowerCase();
  let pick;
  if (found.photo) pick = { _emb: found.photo.vec, _sized: false, quality: { size_px: found.photo.size_px, reason: 'ok' }, box: null };
  else {
    if (!found.ok) return { ok: false, accepted: false, reason: found.reason };
    if (!found.cats.length) return { ok: true, accepted: false, reason: 'no_cat', cats: 0 };
    const usable = found.cats.filter((c) => c._emb);
    if (!usable.length) return { ok: true, accepted: false, reason: 'cat_too_small', size_px: Math.max(...found.cats.map((c) => c.quality.size_px)), needed_px: CAT_MIN_PX, cats: found.cats.length };
    if (Number.isInteger(index)) pick = usable[index] || null;
    else if (usable.length === 1) pick = usable[0];
    else return { ok: true, accepted: false, reason: 'multiple_cats', cats: usable.map((c, i) => ({ index: i, box: c.box, size_px: c.quality.size_px, matches: c.matches })) };
    if (!pick) return { ok: true, accepted: false, reason: 'bad_index', cats: usable.length };
  }
  // the same crop sent twice teaches nothing: a near-identical descriptor already held is a duplicate (1.15.1)
  if (!enrolled) loadEnrolled();
  const existing = enrolledCats[name] || [];
  if (existing.some((it) => catid.cosine(pick._emb, it.embedding, !!pick._sized, it.sized) >= 0.995)) return { ok: true, accepted: false, reason: 'duplicate', samples: existing.length };
  const d = path.join(cfg.identityDir, name);
  fs.mkdirSync(d, { recursive: true });
  // cap per cat: the oldest photo sample goes first, room samples last
  const CAT_MAX = 200;
  if (existing.length >= CAT_MAX) { const old = [...existing].sort((a, b) => (a.source === b.source ? (a.at < b.at ? -1 : 1) : (a.source === 'room' ? 1 : -1)))[0]; try { fs.unlinkSync(path.join(d, old.file)); } catch (e) { /* ok */ } }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const j = { at: new Date().toISOString(), camera: source, source: String(source).startsWith('camera.') ? 'room' : 'upload', quality: pick.quality, box: pick.box, sized: !!pick._sized, embedding: pick._emb };
  fs.writeFileSync(path.join(d, `cat-${ts}.json`), JSON.stringify(j));
  if (cfg.identityKeepSamples && pick._crop) fs.writeFileSync(path.join(d, `cat-${ts}.jpg`), pick._crop);
  loadEnrolled();
  console.log(`[nest_headless] IDENTITY enrolled cat ${name} (${(enrolledCats[name] || []).length} samples, ${pick.quality.size_px}px${found.photo ? ', photo' : ''})`);
  return { ok: true, accepted: true, quality: pick.quality, samples: (enrolledCats[name] || []).length };
}
function catSummary(name) {
  const c = enrolledCats[name] || [];
  return { name, samples: c.length, room: c.filter((it) => it.source === 'room').length, upload: c.filter((it) => it.source !== 'room').length, last_seen: lastMatched[name] || null, updated_at: c.map((i) => i.at).sort().pop() || null };
}
// Match the cats in a surface pass; park the ambiguous ones for a label (kind "cat").
const lastPendingCatMs = {};
async function identifyCats(entityId, jpg, dets) {
  const r = await catsInJpeg(jpg, { dets, camera: entityId });
  if (!r.ok) return [];
  const now = Date.now();
  for (const c of r.cats) {
    if (!c._emb) continue;
    if (!catAmbiguous(c.matches)) { lastMatched[c.matches[0].name] = new Date().toISOString(); continue; }
    if (!Object.keys(enrolledCats).length && !c._crop) continue;
    if (pending.negativeScore('cat', c._emb, catid.cosine) >= CAT_DECISIVE) continue;
    if (now - (lastPendingCatMs[entityId] || 0) < 60000 || !c._crop) continue;   // one cat candidate per camera per minute
    lastPendingCatMs[entityId] = now;
    try {
      const meta = pending.add({ kind: 'cat', camera: entityId.replace(/^camera\./, ''), t: new Date().toISOString(), quality: c.quality, matches: c.matches, embedding: c._emb, size_px: c.quality.size_px, media: { buf: c._crop, ext: 'jpg' } });
      console.log(`[nest_headless] IDENTITY pending cat ${meta.id} (${c.quality.size_px}px, best ${c.matches[0] ? c.matches[0].name + ':' + c.matches[0].score : 'none'})`);
      notePendingCount({ id: meta.id, kind: 'cat', camera: meta.camera, t: meta.t });
    } catch (e) { console.warn('[nest_headless] pending cat failed:', e.message); }
  }
  return r.cats;
}
// Faces in a fresh frame off the held stream: [{name|null, score, box, quality, matches}], largest first.
// ArcFace cosine: same person on this camera ~0.5-0.8, strangers ~0.1-0.3; `name` is set at >= 0.4,
// the full top-3 is always included so the brain can apply its own threshold.
async function facesInBuffer(jpg, { minPx = 40, camera = null } = {}) {
  if (!faces.hasModels(FACE_MODELS_DIR())) return { ok: false, reason: 'no_face_models', faces: [] };
  const found = await faces.facesInJpeg(FACE_MODELS_DIR(), jpg, { minPx });
  if (camera) considerFacesForPending(camera, jpg, found).catch(() => {});
  return { ok: true, faces: (found || []).map((f) => {
    const matches = f.embedding ? matchFace(f.embedding) : [];
    const top = matches[0] && matches[0].score >= 0.4 ? matches[0] : null;
    return { name: top ? top.name : null, score: top ? top.score : null, box: { x: r4(f.box.x), y: r4(f.box.y), w: r4(f.box.w), h: r4(f.box.h) }, quality: f.quality, matches, _emb: f.embedding, _aligned: f.aligned };
  }) };
}
async function facesForCamera(entityId, { minPx = 40 } = {}) {
  const mgr = watchMgr[entityId];
  if (!mgr || !mgr.ready || !mgr.page) return { ok: false, reason: 'camera_not_watched', faces: [] };
  if (!faces.hasModels(FACE_MODELS_DIR())) return { ok: false, reason: 'no_face_models', faces: [] };
  const shot = await mgr.page.evaluate(fns.grabFrame, { quality: cfg.jpegQuality, crop: null });
  const jpg = Buffer.from(shot.dataUrl.split(',')[1], 'base64');
  const at = noteFrame(entityId, jpg);
  const r = await facesInBuffer(jpg, { minPx, camera: entityId });
  r.at = at; r.jpg = jpg;
  for (const f of r.faces || []) f.at = at;
  return r;
}
const r4 = (v) => Math.round(v * 10000) / 10000;
const publicFace = (f) => ({ name: f.name, score: f.score, box: f.box, quality: f.quality, matches: f.matches });
// Sample faces during a speech capture: at the wake hit and ~1 s later; best (largest) per position.
async function sampleFacesForCapture(entityId) {
  const out = [];
  if (loopBusy()) return out;
  try {
    const a = await facesForCamera(entityId); out.push(...a.faces);
    await new Promise((r) => setTimeout(r, 1000));
    const b = await facesForCamera(entityId); out.push(...b.faces);
  } catch (e) { /* stream hiccup */ }
  // dedupe by box overlap: keep the larger of any two faces at the same spot
  const keep = [];
  for (const f of out.sort((x, y) => y.box.w * y.box.h - x.box.w * x.box.h)) {
    if (!keep.some((k) => Math.abs(k.box.x - f.box.x) < 0.05 && Math.abs(k.box.y - f.box.y) < 0.05)) keep.push(f);
  }
  return keep.map((f) => ({ ...publicFace(f), at: f.at || null }));
}
// ------------------------------------------------------------ verification backlog (Hearth #16)
// Good-quality samples whose match is ambiguous or unknown are parked for an
// admin to label, mark as "not a household member", or drop. Decisive: voice
// >= 0.6, face >= 0.5, and a clear gap to the runner-up.
const VOICE_DECISIVE = 0.6, FACE_DECISIVE = 0.5, AMBIGUOUS_GAP = 0.1;
const lastMatched = {};        // name -> ISO time of the last decisive match
const lastPendingFaceMs = {};  // camera -> ms; one face candidate per camera per minute
function ambiguous(matches, decisive) {
  if (!matches.length || matches[0].score < decisive) return true;
  return !!(matches[1] && matches[0].score - matches[1].score < AMBIGUOUS_GAP);
}
function notePendingCount(newest) {
  postHaEvent('nest_headless_identity_pending', { count: pending.count(), ...(newest ? { newest } : {}) }).catch(() => {});
}
function considerVoiceForPending(entityId, u, matches, utteranceId) {
  try {
    if (!u.embedding || !u.quality || u.quality.reason !== 'ok') return;
    if (!ambiguous(matches, VOICE_DECISIVE)) {
      lastMatched[matches[0].name] = new Date().toISOString();
      autoSample(matches[0].name, 'voice', { camera: entityId, quality: u.quality, embedding: u.embedding, utterance_id: utteranceId, matches });
      return;
    }
    if (pending.negativeScore('voice', u.embedding, cosine) >= VOICE_DECISIVE) return;   // a known non-speech source (#18)
    if (pending.unknownScore('voice', u.embedding, cosine) >= VOICE_DECISIVE) return;   // a visitor already marked unknown
    const clip = u.samples.length > 160000 ? u.samples.subarray(0, 160000) : u.samples;  // <= 10 s
    const meta = pending.add({ kind: 'voice', camera: entityId.replace(/^camera\./, ''), t: new Date().toISOString(), utterance_id: utteranceId,
      quality: u.quality, matches, embedding: u.embedding, speech_ms: u.quality.speech_ms, media: { buf: wavBuffer(clip), ext: 'wav' } });
    console.log(`[nest_headless] IDENTITY pending voice ${meta.id} (best ${matches[0] ? matches[0].name + ':' + matches[0].score : 'none'})`);
    notePendingCount({ id: meta.id, kind: 'voice', camera: meta.camera, t: meta.t });
  } catch (e) { console.warn('[nest_headless] pending voice failed:', e.message); }
}
async function considerFacesForPending(entityId, jpg, found) {
  if (loopBusy()) return;
  try {
    const now = Date.now();
    if (now - (lastPendingFaceMs[entityId] || 0) < 60000) return;
    const sharp = getSharp(); if (!sharp) return;
    for (const f of found || []) {
      if (!f.embedding || f.quality.size_px < 60) continue;
      const matches = matchFace(f.embedding);
      if (!ambiguous(matches, FACE_DECISIVE)) { lastMatched[matches[0].name] = new Date().toISOString(); continue; }
      if (pending.negativeScore('face', f.embedding, faces.cosine) >= FACE_DECISIVE) continue;   // a known "not a person" (#18)
      if (pending.unknownScore('face', f.embedding, faces.cosine) >= FACE_DECISIVE) continue;
      // a human-readable crop: the face box with 2.5x context
      const m = await sharp(jpg).metadata();
      const side = Math.round(Math.max(f.box.w * m.width, f.box.h * m.height) * 2.5);
      const left = Math.max(0, Math.round((f.box.x + f.box.w / 2) * m.width - side / 2)), top = Math.max(0, Math.round((f.box.y + f.box.h / 2) * m.height - side / 2));
      const crop = await sharp(jpg).extract({ left, top, width: Math.min(m.width - left, side), height: Math.min(m.height - top, side) }).jpeg({ quality: 88 }).toBuffer();
      const meta = pending.add({ kind: 'face', camera: entityId.replace(/^camera\./, ''), t: new Date().toISOString(),
        quality: f.quality, matches, embedding: f.embedding, size_px: f.quality.size_px, media: { buf: crop, ext: 'jpg' } });
      lastPendingFaceMs[entityId] = now;
      console.log(`[nest_headless] IDENTITY pending face ${meta.id} (${f.quality.size_px}px, best ${matches[0] ? matches[0].name + ':' + matches[0].score : 'none'})`);
      notePendingCount({ id: meta.id, kind: 'face', camera: meta.camera, t: meta.t });
      break;
    }
  } catch (e) { console.warn('[nest_headless] pending face failed:', e.message); }
}
function writePersonSample(name, kind, record, mediaSrc) {
  name = name.toLowerCase();
  const d = path.join(cfg.identityDir, name);
  fs.mkdirSync(d, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `${kind}-${ts}.json`, j = { at: new Date().toISOString(), ...record };
  diskq.writeAtomic(path.join(d, file), Buffer.from(JSON.stringify(j))).catch((e) => console.warn('[nest_headless] identity sample write failed:', e.message));
  if (cfg.identityKeepSamples && mediaSrc) try { fs.copyFileSync(mediaSrc, path.join(d, `${kind}-${ts}.${mediaSrc.endsWith('.wav') ? 'wav' : 'jpg'}`)); } catch (e) { /* optional */ }
  // keep the in-memory index current without re-reading the identity dir (a share)
  if (!enrolled) loadEnrolled();
  const map = kind === 'voice' ? enrolled : enrolledFaces;
  (map[name] = map[name] || []).push(sampleItem(file, j));
}
// Confident room matches feed the room channel (#16): someone enrolled from
// phone recordings scores lower on a ceiling microphone (level, reverb and
// bandwidth differ), so a decisive room capture is kept as a room sample.
// Embeddings only - never audio - at most AUTO_MAX per person with the
// oldest auto sample displaced, one per person per AUTO_GAP_MS. Explicit
// enrolments and admin labels are never displaced. identity_auto_samples
// turns it off.
const AUTO_MAX = 12, AUTO_GAP_MS = 10 * 60000;
const lastAutoMs = {};
function autoSample(name, kind, record) {
  try {
    if (!cfg.identityAutoSamples || !record.embedding) return;
    const key = `${kind}:${name}`, now = Date.now();
    if (now - (lastAutoMs[key] || 0) < AUTO_GAP_MS) return;
    lastAutoMs[key] = now;
    const map = kind === 'voice' ? enrolled : enrolledFaces;
    const items = map[name] || [];
    const autos = items.filter((it) => it.auto).sort((a, b) => (a.at < b.at ? -1 : 1));
    for (const old of autos.slice(0, Math.max(0, autos.length + 1 - AUTO_MAX))) {
      items.splice(items.indexOf(old), 1);
      fs.promises.unlink(path.join(cfg.identityDir, name, old.file)).catch(() => {});
    }
    writePersonSample(name, kind, { ...record, source: 'room', auto: true });
    console.log(`[nest_headless] IDENTITY room ${kind} sample kept for ${name} (auto ${Math.min(AUTO_MAX, autos.length + 1)}/${AUTO_MAX})`);
  } catch (e) { console.warn('[nest_headless] auto sample failed:', e.message); }
}
function enrolPending(id, name) {
  if (!/^[a-z0-9_-]{1,32}$/i.test(name)) return { ok: false, accepted: false, reason: 'bad_name' };
  const m = pending.get(id);
  if (!m) return { ok: false, accepted: false, reason: 'unknown_sample' };
  const media = pending.mediaPath(id);
  writePersonSample(name, m.kind, { camera: m.camera, source: 'room', quality: m.quality, embedding: m.embedding, from_pending: id, matches_at_label: m.matches }, media && media.file);
  pending.remove(id);
  console.log(`[nest_headless] IDENTITY labelled pending ${id} as ${name.toLowerCase()} (${m.kind})`);
  notePendingCount();
  return { ok: true, accepted: true, ...personSummary(name.toLowerCase()), pending: pending.count() };
}
function personSummary(name) {
  if (!enrolled) loadEnrolled();
  const v = enrolled[name] || [], f = enrolledFaces[name] || [];
  const poses = [...new Set(f.map((it) => it.pose).filter(Boolean))];
  const bySource = (arr) => ({ room: arr.filter((it) => it.source === 'room').length, upload: arr.filter((it) => it.source !== 'room').length, auto: arr.filter((it) => it.auto).length });
  return { name, voice_samples: v.length, face_samples: f.length, poses_held: poses, last_matched: lastMatched[name] || null,
    voice_sources: bySource(v), face_sources: bySource(f),
    updated_at: [...v, ...f].map((i) => i.at).sort().pop() || null };
}
// ---- the recognition corpus for review (#24): every enrolled sample per
// name (people and cats alike), its media when kept, and deletion.
async function contextCrop(sharp, jpg, box, factor = 2.5) {
  const m = await sharp(jpg).metadata();
  const side = Math.round(Math.max(box.w * m.width, box.h * m.height) * factor);
  const left = Math.max(0, Math.round((box.x + box.w / 2) * m.width - side / 2)), top = Math.max(0, Math.round((box.y + box.h / 2) * m.height - side / 2));
  return sharp(jpg).extract({ left, top, width: Math.min(m.width - left, side), height: Math.min(m.height - top, side) }).jpeg({ quality: 88 }).toBuffer();
}
const SAMPLE_ID = /^(voice|face|cat)-[0-9TZ-]{20,40}$/;
function listSamples(name) {
  const d = path.join(cfg.identityDir, name);
  if (!/^[a-z0-9_-]{1,32}$/i.test(name) || !fs.existsSync(d)) return null;
  const files = new Set(fs.readdirSync(d));
  const out = [];
  for (const f of [...files].filter((x) => /^(voice|face|cat)-.*\.json$/.test(x)).sort()) {
    const id = f.replace(/\.json$/, '');
    let j; try { j = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch (e) { continue; }
    const kind = id.split('-')[0];
    const media = files.has(id + '.jpg') ? id + '.jpg' : (files.has(id + '.wav') ? id + '.wav' : null);
    out.push({ id, kind, t: j.at || null, source: j.auto ? 'auto' : (j.source || (String(j.camera || '').startsWith('camera.') ? 'room' : 'upload')),
      camera: j.camera || null, size_px: j.quality && j.quality.size_px != null ? j.quality.size_px : undefined, speech_ms: j.quality && j.quality.speech_ms != null ? j.quality.speech_ms : undefined,
      quality: j.quality || null, pose: j.pose || null, phrase: j.phrase || null, from_pending: j.from_pending || null,
      media_url: media ? `/identity/${kind === 'cat' ? 'cat/' : ''}${name}/samples/${id}/media` : null, used: true });
  }
  return out;
}
function sampleMedia(name, id) {
  if (!/^[a-z0-9_-]{1,32}$/i.test(name) || !SAMPLE_ID.test(id)) return null;
  const d = path.join(cfg.identityDir, name);
  for (const [ext, type] of [['.jpg', 'image/jpeg'], ['.wav', 'audio/wav']]) { const f = path.join(d, id + ext); if (fs.existsSync(f)) return { file: f, type }; }
  return null;
}
function deleteSample(name, id) {
  if (!/^[a-z0-9_-]{1,32}$/i.test(name) || !SAMPLE_ID.test(id)) return { ok: false, reason: 'bad_id' };
  const d = path.join(cfg.identityDir, name);
  if (!fs.existsSync(path.join(d, id + '.json'))) return { ok: false, reason: 'unknown_sample' };
  for (const ext of ['.json', '.jpg', '.wav']) { try { fs.unlinkSync(path.join(d, id + ext)); } catch (e) { /* ok */ } }
  loadEnrolled();
  const kind = id.split('-')[0];
  const left = (kind === 'cat' ? enrolledCats[name] : kind === 'voice' ? enrolled[name] : enrolledFaces[name]) || [];
  console.log(`[nest_headless] IDENTITY dropped sample ${id} of ${name} (${left.length} ${kind} left)`);
  return { ok: true, samples: left.length, kind };
}
// Uploaded WAV (RIFF, 16-bit PCM, any rate/channels) -> 16 kHz float32 mono.
function wavToFloat16k(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a WAV');
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4), size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) };
    else if (id === 'data') data = buf.subarray(pos + 8, pos + 8 + size);
    pos += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV missing fmt/data');
  if (fmt.bits !== 16) throw new Error('16-bit PCM WAV expected');
  const n = Math.floor(data.length / 2 / fmt.channels);
  let mono = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let c = 0; c < fmt.channels; c++) s += data.readInt16LE((i * fmt.channels + c) * 2); mono[i] = s / fmt.channels / 32768; }
  if (fmt.rate !== 16000) {
    const sherpa = require('sherpa-onnx-node');
    const rs = new sherpa.LinearResampler(fmt.rate, 16000);
    const r = rs.resample(mono, true); mono = Float32Array.from(r.samples || r);
  }
  return mono;
}
// Uploaded audio (#16, #19): WAV is parsed here; m4a/caf/aac/mp3 go through
// the host's converter (afconvert on macOS, else ffmpeg) via a private temp
// file removed at once. Returns 16 kHz mono float samples.
async function decodeUploadedAudio(buf, format) {
  const f = String(format || 'wav').toLowerCase().replace(/^audio\//, '').replace(/^x-/, '');
  if (f === 'wav' || f === 'wave' || buf.toString('ascii', 0, 4) === 'RIFF') return wavToFloat16k(buf);
  if (!['m4a', 'caf', 'aac', 'mp4', 'aiff', 'aif', 'mp3', 'flac'].includes(f)) throw new Error('unsupported_format');
  const fsp = require('fs/promises'); const { execFile } = require('child_process');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'nh-'));
  const src = path.join(dir, 'in.' + f), dst = path.join(dir, 'out.wav');
  const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 20000 }, (e) => (e ? reject(e) : resolve())));
  try {
    await fsp.writeFile(src, buf, { mode: 0o600 });
    try { await run('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', src, dst]); }
    catch (e) { await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-ac', '1', '-ar', '16000', '-f', 'wav', dst]).catch(() => { throw new Error('no_converter'); }); }
    return wavToFloat16k(await fsp.readFile(dst));
  } finally { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}
// Peak-normalise first (to -3 dBFS, at most x20), as utterances are: a phone
// recording raw at arm's length sat under an absolute floor although speech
// was there. Then voiced = a 250 ms chunk over 3% of full scale.
function prepareUploadedVoice(samples, maxSeconds = 12) {
  if (samples.length > 16000 * maxSeconds) samples = samples.subarray(0, 16000 * maxSeconds);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
  const gain = peak > 0 ? Math.min(20, 0.7 / peak) : 1;
  if (gain > 1.05) { const n = new Float32Array(samples.length); for (let i = 0; i < samples.length; i++) n[i] = Math.max(-1, Math.min(1, samples[i] * gain)); samples = n; }
  let voicedMs = 0, acc = 0;
  for (let i = 0; i + 4000 <= samples.length; i += 4000) { const r = rmsOf(samples.subarray(i, i + 4000)); if (r > 0.02) voicedMs += 250; acc += r; }
  return { samples, quality: { speech_ms: voicedMs, rms: Math.round(acc / Math.max(1, Math.floor(samples.length / 4000)) * 10000) / 10000 } };
}
// Who is speaking in an uploaded clip (#19): the same scoring as
// speaker.matches on the identity event. Nothing is kept: no backlog, no
// auto sample - the clip is not from a room microphone and the caller
// (the brain) owns the attribution decision.
function identifyVoiceClip(samplesIn) {
  const { samples, quality } = prepareUploadedVoice(samplesIn, 15);
  quality.reason = quality.speech_ms < 1000 ? 'too_short' : 'ok';
  if (quality.reason !== 'ok') return { ok: true, quality, matches: [], too_short: true, reason: 'too_short', needed_speech_ms: 1000 };
  const emb = embedVoice(samples);
  if (!emb) return { ok: false, quality, matches: [], reason: 'no_model' };
  const matches = matchVoice(emb);
  return { ok: true, quality, matches, decisive: !ambiguous(matches, VOICE_DECISIVE) };
}
function enrolVoiceFromAudio(name, samplesIn, phrase, camera) {
  if (!/^[a-z0-9_-]{1,32}$/i.test(name)) return { ok: false, accepted: false, reason: 'bad_name' };
  const { samples, quality } = prepareUploadedVoice(samplesIn, 12);
  quality.reason = quality.speech_ms < 2000 ? 'too_short' : 'ok';   // >= 2 s needed to enrol
  if (quality.reason !== 'ok') return { ok: true, accepted: false, reason: quality.reason, quality, speech_ms: quality.speech_ms, needed_speech_ms: 2000, samples: (enrolled && enrolled[name.toLowerCase()] || []).length };
  const emb = embedVoice(samples);
  if (!emb) return { ok: false, accepted: false, reason: 'no_model' };
  const d = path.join(cfg.identityDir, name.toLowerCase());
  fs.mkdirSync(d, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(d, `voice-${ts}.json`), JSON.stringify({ at: new Date().toISOString(), camera: camera || 'upload', source: String(camera || '').startsWith('camera.') ? 'room' : 'upload', phrase: phrase || null, quality, embedding: emb }));
  if (cfg.identityKeepSamples) writeWav16k(path.join(d, `voice-${ts}.wav`), samples);
  loadEnrolled();
  console.log(`[nest_headless] IDENTITY enrolled voice for ${name.toLowerCase()} from upload (${enrolled[name.toLowerCase()].length} samples${phrase ? ', phrase: ' + String(phrase).slice(0, 40) : ''})`);
  return { ok: true, accepted: true, quality, samples: enrolled[name.toLowerCase()].length };
}

function enrolFace(name, entityId, found, index, pose) {
  if (!/^[a-z0-9_-]{1,32}$/i.test(name)) return { ok: false, accepted: false, reason: 'bad_name' };
  if (!found.ok) return { ok: false, accepted: false, reason: found.reason };
  const usable = found.faces.filter((f) => f._emb);
  const sizes = found.faces.map((f) => f.quality.size_px);
  if (!found.faces.length) return { ok: true, accepted: false, reason: 'no_face', faces: 0 };
  if (!usable.length) return { ok: true, accepted: false, reason: 'face_too_small', size_px: Math.max(...sizes), needed_px: 60, faces: found.faces.length };
  let pick = null;
  if (Number.isInteger(index)) pick = usable[index] || null;
  else if (usable.length === 1) pick = usable[0];
  else return { ok: true, accepted: false, reason: 'multiple_faces', faces: usable.map((f, i) => ({ index: i, box: f.box, size_px: f.quality.size_px, matches: f.matches })) };
  if (!pick) return { ok: true, accepted: false, reason: 'bad_index', faces: usable.length };
  if (pick.quality.size_px < 60) return { ok: true, accepted: false, reason: 'face_too_small', size_px: pick.quality.size_px, needed_px: 60 };
  const d = path.join(cfg.identityDir, name.toLowerCase());
  fs.mkdirSync(d, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const POSES = ['front', 'left', 'right', 'up', 'down'];
  const p = POSES.includes(String(pose || '').toLowerCase()) ? String(pose).toLowerCase() : null;
  fs.writeFileSync(path.join(d, `face-${ts}.json`), JSON.stringify({ at: new Date().toISOString(), camera: entityId, source: String(entityId).startsWith('camera.') ? 'room' : 'upload', quality: pick.quality, box: pick.box, pose: p, embedding: pick._emb }));
  if (cfg.identityKeepSamples) {
    // for review (#24): a context crop (the face box with 2.5x margin) from the
    // source frame when we have it, else the aligned 112 px crop
    const sharpM = getSharp();
    if (found.jpg && sharpM) {
      contextCrop(sharpM, found.jpg, pick.box).then((crop) => diskq.writeAtomic(path.join(d, `face-${ts}.jpg`), crop)).catch(() => {});
    } else if (pick._aligned) {
      const rgba = Buffer.alloc(faces.ALIGN * faces.ALIGN * 4);
      for (let i = 0; i < faces.ALIGN * faces.ALIGN; i++) { rgba[i * 4] = pick._aligned[i * 3]; rgba[i * 4 + 1] = pick._aligned[i * 3 + 1]; rgba[i * 4 + 2] = pick._aligned[i * 3 + 2]; rgba[i * 4 + 3] = 255; }
      fs.writeFileSync(path.join(d, `face-${ts}.jpg`), require('jpeg-js').encode({ data: rgba, width: faces.ALIGN, height: faces.ALIGN }, 90).data);
    }
  }
  loadEnrolled();
  console.log(`[nest_headless] IDENTITY enrolled face for ${name.toLowerCase()} (${enrolledFaces[name.toLowerCase()].length} samples, ${pick.quality.size_px}px${p ? ', ' + p : ''})`);
  return { ok: true, accepted: true, quality: pick.quality, samples: enrolledFaces[name.toLowerCase()].length, poses_held: personSummary(name.toLowerCase()).poses_held };
}
// score = best over every sample (unchanged); room / upload = best over the
// samples from that channel, null when the person has none. A phone-enrolled
// voice heard on a ceiling microphone scores lower (level, reverb and
// bandwidth differ), and this lets the brain see that rather than guess (#16).
function matchVoice(embedding) {
  if (!enrolled) loadEnrolled();
  if (pending.negativeScore('voice', embedding, cosine) >= VOICE_DECISIVE) return [];   // a known non-speech source (#18)
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const out = [];
  for (const [name, items] of Object.entries(enrolled)) {
    let best = -1, room = null, upload = null;
    for (const it of items) {
      const s = cosine(embedding, it.embedding);
      if (s > best) best = s;
      if (it.source === 'room') room = room === null ? s : Math.max(room, s);
      else upload = upload === null ? s : Math.max(upload, s);
    }
    out.push({ name, score: r3(best), room: room === null ? null : r3(room), upload: upload === null ? null : r3(upload) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}
// recent utterances kept 90 s for enrolment: id -> {camera, samples, quality, embedding, at}
const utterances = new Map();
// Utterances the house was addressed on stay in memory for UTTERANCE_KEEP_MS
// (24 h, cap UTTERANCE_MAX oldest-out) so the app can play the evidence
// behind a decision (#21); the rest 90 s. Memory only: gone on restart,
// never on disk here.
const UTTERANCE_KEEP_MS = 24 * 3600000, UTTERANCE_MAX = 300;
function rememberUtterance(id, u, keepMs = 90000) {
  utterances.set(id, u);
  setTimeout(() => utterances.delete(id), keepMs).unref();
  if (utterances.size > UTTERANCE_MAX) { const oldest = [...utterances.entries()].sort((a, b) => a[1].at - b[1].at)[0]; if (oldest) utterances.delete(oldest[0]); }
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
  fs.writeFileSync(path.join(d, `voice-${ts}.json`), JSON.stringify({ at: new Date().toISOString(), camera: u.camera, source: 'room', quality: u.quality, embedding: emb }));
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
  const names = new Set([...Object.keys(enrolled), ...Object.keys(enrolledFaces)]);
  return { people: [...names].map((name) => ({
    name, voice_samples: (enrolled[name] || []).length, face_samples: (enrolledFaces[name] || []).length,
    updated_at: [...(enrolled[name] || []), ...(enrolledFaces[name] || [])].map((i) => i.at).sort().pop() || null,
  })), cats: Object.keys(enrolledCats).sort().map(catSummary),   // cats live beside people (#23)
  face_models: faces.hasModels(FACE_MODELS_DIR()), pending: pending.count(), negatives: pending.negativeCount() };
}
function readJsonBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 8e6) req.destroy(); });   // 8 MB: room for a base64 1080p JPEG
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } });
  });
}

// Per-camera capture state: after a keyword hit, accumulate 16k samples until
// silence-after-speech or the max window, then recognise and post ONE event.
const speechCap = {};
function rmsOf(a) { let acc = 0; for (let i = 0; i < a.length; i++) acc += a[i] * a[i]; return Math.sqrt(acc / Math.max(1, a.length)); }
const recentCaptureStart = {}; // entityId -> t0 of the latest capture (for concurrent_cameras)
// opts.followUp (Hearth #4): a listening window opened by the brain right
// after it has spoken - no wake phrase, so no tail phase; a short pre-roll;
// gives up silently after opts.giveUpMs if nobody speaks.
function startSpeechCapture(entityId, keyword, ring, opts = {}) {
  if (segTrackers[entityId]) segTrackers[entityId].reset();   // the capture owns this audio now; no duplicate from the segment path
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
  const t0 = Date.now();
  // another camera already capturing the same sentence (started within 1.5 s): this one is its twin and skips the speculative pass
  const twin = Object.entries(recentCaptureStart).find(([cam, at]) => cam !== entityId && Math.abs(at - t0) < 1500 && speechCap[cam]);
  recentCaptureStart[entityId] = t0;
  speechCap[entityId] = {
    twinOf: twin ? twin[0] : null,
    keyword, chunks: [...pre], startedAt: new Date(), t0,
    floor, phase: opts.followUp ? 'listen' : 'tail', tailQuietMs: 0, keepFrom: opts.followUp ? 0 : pre.length,
    listenT0: opts.followUp ? Date.now() : null, voicedMs: 0, silenceMs: 0,
    followUp: !!opts.followUp, giveUpMs: opts.giveUpMs || 0,
    // faces at the wake moment (+1 s), in parallel with the capture; used by the identity event
    facesPromise: faces.hasModels(FACE_MODELS_DIR()) ? sampleFacesForCapture(entityId) : null,
  };
  const c0 = speechCap[entityId];
  if (c0.facesPromise) c0.facesPromise.then((v) => { c0.facesResult = v; }).catch(() => {});
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
// Provisional transcript from the speculative pass (final: false). Only for
// captures the house was addressed on (a wake word or a reply window), and
// only when the wake phrase is actually in it for wake captures, so ordinary
// talk after a spotter false alarm never goes out early.
function postPartial(entityId, c, r) {
  try {
    const wake = !!r.text && (WAKE_RE.test(r.text) || WAKE_HEAD_RE.test(r.text));
    if (!c.followUp && !wake) return;
    const text = stripWakePhrase(r.text);
    if (!text) return;
    postHaEvent('nest_headless_speech_partial', {
      entity_id: entityId, camera: entityId.replace(/^camera\./, ''), utterance_id: `${entityId.replace(/^camera\./, '')}-${c.t0}`,
      text, engine: r.engine, final: false, wake_confirmed: wake,
      ...(c.followUp ? { opened_by: c.openedBy || null, open_reason: c.openReason || null } : {}),
    }).catch(() => {});
  } catch (e) { /* provisional only */ }
}
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
    if (voiced) { c.voicedMs += ms; c.silenceMs = 0; if (c.spec) c.specStale = true; } else c.silenceMs += ms;
    const spoke = c.voicedMs >= SPEECH_MIN_VOICED_MS, listened = Date.now() - c.listenT0;
    // Speculative transcription during the closing silence (see
    // finishSpeechCapture): started at 250 ms of quiet (the recogniser is
    // fast enough now), skipped on the twin capture of a sentence two mics
    // heard. Its text also goes out as nest_headless_speech_partial so the
    // brain can start thinking before the window closes, and a transcript
    // ending in a question mark closes the capture at 400 ms of quiet
    // instead of the full speech_silence_ms: a question is done when asked.
    if (spoke && !voiced && c.silenceMs >= 250 && c.silenceMs < cfg.speechSilenceMs && (!c.spec || c.specStale) && !c.twinOf) {
      const kept = c.chunks.slice(Math.min(c.keepFrom || 0, Math.max(0, c.chunks.length - 1)));
      c.specStale = false; c.specText = null;
      const p = transcribeSamples(samplesFromChunks(kept));
      c.spec = p;
      p.then((r) => { if (c.spec === p && !c.specStale) { c.specText = r.text; postPartial(entityId, c, r); } }).catch(() => {});
    }
    const questionDone = !!c.specText && !c.specStale && /\?["')\]]*\s*$/.test(c.specText) && c.silenceMs >= 400;
    if (spoke && (c.silenceMs >= cfg.speechSilenceMs || questionDone)) reason = 'silence';
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
// for different voices ("Claws", "God", "Cloud", ...).
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
function whisperServer(samples, base = cfg.sttUrl) {
  return new Promise((resolve, reject) => {
    const boundary = '----nest' + Date.now().toString(36);
    const field = (name, value) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="u.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
      wavBuffer(samples), Buffer.from('\r\n'),
      field('response_format', 'json'), field('temperature', '0'), field('language', 'en'),
      Buffer.from(`--${boundary}--\r\n`),
    ]);
    const u = new URL(base + '/inference');
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
// Names the recognisers render the wake word as ("Claude" comes back as
// Claws, God, Cloud... depending on the voice). WAKE_NAMES overrides the
// whole list (pipe-separated, lower case) for other wake words.
const WAKE_NAMES = (process.env.WAKE_NAMES || 'claude|claud|clawed|claws|clause|cloud|cloudy|clod|clawd|klaud|klaus|clyde|cord|god|kitchen').toLowerCase();
// The wake phrase sits at the START of the transcript (the pre-roll is 1.5 s,
// so at most a few words of junk precede it - hence {0,40}); a wake phrase
// further in is someone quoting it (a spoken reply that contained "say hey
// Claude" once had everything before it stripped by an unbounded prefix).
// A quiet "hey" transcribes as "a" or "eh".
const WAKE_WORDS = 'hey|hi|ok|okay|a|eh|hay';
const WAKE_RE = new RegExp(`^[\\s\\S]{0,40}?\\b(?:${WAKE_WORDS})[,.!?]?\\s+(?:${WAKE_NAMES})\\b[,.!?]*\\s*`, 'i');
// pre-roll cut mid-phrase: transcript starts with the bare name ("clawed, is the...")
const WAKE_HEAD_RE = new RegExp(`^\\W*(?:${WAKE_NAMES})\\b[,.!?]*\\s*`, 'i');
// repeats ("hey claude, hey claude, ...") must be right at the head
const WAKE_REPEAT_RE = new RegExp(`^\\W*(?:${WAKE_WORDS})[,.!?]?\\s+(?:${WAKE_NAMES})\\b[,.!?]*\\s*`, 'i');
function stripWakePhrase(t) {
  const m = WAKE_RE.exec(t) || WAKE_HEAD_RE.exec(t);
  if (!m) return t;
  t = t.slice(m[0].length).trim();
  for (let i = 0; i < 2; i++) { const r = WAKE_REPEAT_RE.exec(t); if (!r) break; t = t.slice(r[0].length).trim(); }
  return t;
}
// Concatenate the recogniser's chunks, normalise, transcribe. Shared by the
// final pass and the speculative pass started during the closing silence.
function samplesFromChunks(chunks) {
  const total = chunks.reduce((a, b) => a + b.length, 0);
  const all = new Float32Array(total); let o = 0;
  for (const ch of chunks) { all.set(ch, o); o += ch.length; }
  // Normalise for the recogniser (peak to -3 dBFS, at most x20): the mic sits
  // high on a wall and speech from the far side of a large room arrives
  // at rms 0.01-0.08, which Whisper reads as noise; scaled, it reads it fine.
  let peak = 0;
  for (let i = 0; i < all.length; i++) { const a = Math.abs(all[i]); if (a > peak) peak = a; }
  const gain = peak > 0 ? Math.min(20, 0.7 / peak) : 1;
  if (gain > 1.05) for (let i = 0; i < all.length; i++) all[i] = Math.max(-1, Math.min(1, all[i] * gain));
  return all;
}
async function transcribeSamples(all) {
  const tStt = Date.now();
  let text = '', stt = getStt(), remote = null;
  if (cfg.sttShadowUrl) {   // bake-off: log what the shadow engine hears, in parallel, never used
    const t0 = Date.now();
    whisperServer(all, cfg.sttShadowUrl)
      .then((r) => console.log(`[nest_headless] SHADOW ${r.engine} "${r.text}" (${Date.now() - t0} ms, ${(all.length / 16000).toFixed(1)} s audio)`))
      .catch((e) => console.warn(`[nest_headless] SHADOW failed: ${e.message}`));
  }
  if (cfg.sttUrl) {
    remote = await whisperServer(all).catch((e) => { console.warn(`[nest_headless] stt server ${cfg.sttUrl} failed: ${e.message}`); return null; });
    // the backup server (a different engine kept warm) before the in-process recogniser
    if (!remote && cfg.sttFallbackUrl) remote = await whisperServer(all, cfg.sttFallbackUrl).catch((e) => { console.warn(`[nest_headless] fallback stt ${cfg.sttFallbackUrl} failed too: ${e.message}`); return null; });
    if (!remote) { sttFailStreak++; console.warn(`[nest_headless] using the local recogniser (${sttFailStreak} remote failures in a row)`); } else sttFailStreak = 0;
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
  return { text, engine: stt ? stt.engine : null, sttMs: Date.now() - tStt };
}
async function finishSpeechCapture(entityId, c, reason) {
  if (c.followUp && reason === 'no_speech') {   // nobody replied: no event at all (Hearth #4)
    console.log(`[nest_headless] follow-up window on ${entityId} closed: nobody spoke`);
    return;
  }
  const endedAt = new Date();
  const tClose = Date.now();
  // recogniser audio starts after the wake phrase's tail (see feedSpeechCapture)
  const kept = c.chunks.slice(Math.min(c.keepFrom || 0, Math.max(0, c.chunks.length - 1)));
  const all = samplesFromChunks(kept);
  let text = '', stt = null, sttMs = 0, speculative = false;
  // Quiet speech (Hearth #15): a child across the kitchen speaks at rms
  // 0.01-0.02, around the end-pointer's floor, so "has spoken" never accrues
  // and the capture ends as no_speech although two seconds were voiced. If
  // the post-wake audio carries faint energy for >= 600 ms, let the
  // recogniser decide instead of the floor - one extra call on captures
  // that would otherwise be dropped unheard.
  const post = c.chunks.slice(Math.max(c.keepFrom || 0, 0));
  const faintMs = post.filter((ch) => rmsOf(ch) > c.floor * 0.6).reduce((a, ch) => a + ch.length / 16, 0);
  const faint = reason === 'no_speech' && faintMs >= 600;
  if (reason !== 'no_speech' || faint) {
    // Speculative pass: transcription started at 350 ms of closing silence
    // (feedSpeechCapture); if nobody spoke again before the window closed, the
    // result is already here and the event goes out ~0.5 s sooner.
    const r = (c.spec && !c.specStale) ? await c.spec.then((x) => { speculative = true; return x; }).catch(() => null) : null;
    const t = r || await transcribeSamples(all);
    text = t.text; stt = { engine: t.engine }; sttMs = t.sttMs;
    if (faint) reason = 'quiet_speech';   // resolved to "" below if the recogniser also heard nothing
  }
  // The spotter is deliberately eager (threshold 0.12) and fires on ordinary
  // talk now and then; Whisper hearing the wake phrase in the pre-roll is
  // the second opinion. Unconfirmed captures are still sent - the brain
  // decides - but flagged, so an 8 s ramble after a false wake is cheap to
  // discard.
  const text0 = text;
  // A segment has its whole start, so it must carry the full wake phrase; the
  // bare-name rule exists only for spotter captures whose pre-roll may have
  // cut the "hey" (a hallway sentence beginning "kitchen speaker" once passed).
  const wakeConfirmed = !!text && (WAKE_RE.test(text) || (!c.fromSegment && WAKE_HEAD_RE.test(text)));
  text = stripWakePhrase(text);
  // Whisper's stage directions - "(baby crying)", "[inaudible]", "(background
  // noise drowns out speaker)" - are not something the brain should parse.
  if (text && /^[\s(\[][^A-Za-z0-9]*[^()\[\]]*[)\]]\W*$/.test(text) && !/[a-z]{2,}\s+[a-z]{2,}.*[a-z]/i.test(text.replace(/[(\[][^)\]]*[)\]]/g, ''))) { text = ''; reason = 'unclear'; }
  if (reason === 'quiet_speech' && !text) reason = 'no_speech';   // the recogniser agreed with the floor: nothing there
  // Transcript wake path (wake_by_transcript): a segment nobody addressed to
  // the house - no wake phrase at its head, no open conversation window -
  // ends here. Nothing is kept, logged or sent. A wake phrase makes it a
  // keyword hit with the transcript already in hand; an open window makes
  // it the reply the brain was waiting for (one reply closes the window).
  if (c.fromSegment) {
    if (!wakeConfirmed && !c.followUp) { segStat(entityId, 'segments_dropped'); return; }
    if (wakeConfirmed && !c.followUp) {
      const wm = WAKE_RE.exec(text0) || WAKE_HEAD_RE.exec(text0);
      c.keyword = (wm ? wm[0] : 'wake').replace(/[^A-Za-z ]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase().split(' ').slice(-2).join(' ');
      lastKeywordMs[entityId] = Date.now();
      segStat(entityId, 'segment_wakes');
      console.log(`[nest_headless] KEYWORD "${c.keyword}" on ${entityId} (transcript) at ${new Date().toISOString()}`);
      postHaEvent('nest_headless_keyword', { entity_id: entityId, camera: entityId.replace(/^camera\./, ''), keyword: c.keyword, source: 'transcript' }).catch(() => {});
    } else if (text) { segStat(entityId, 'segment_follow_ups'); if (convo[entityId] && convo[entityId].openedAt === c.windowOpenedAt) delete convo[entityId]; }
    // faces only now, once the segment is known to be addressed to the house
    if (!c.facesPromise && faces.hasModels(FACE_MODELS_DIR())) c.facesPromise = sampleFacesForCapture(entityId);
  }
  if (c.followUp && !text) {   // a follow-up window that caught only noise is the same as nobody replying (Hearth #4)
    console.log(`[nest_headless] follow-up window on ${entityId} closed: nothing intelligible (${reason})`);
    return;
  }
  const durationMs = Math.round(all.length / 16);
  const utteranceId = `${entityId.replace(/^camera\./, '')}-${c.t0}`;
  const closeToEventMs = Date.now() - tClose;
  const seenFaces = c.facesResult || [];   // faces already sampled (never awaited here: the transcript must not wait)
  console.log(`[nest_headless] SPEECH "${text}" on ${entityId} (${durationMs} ms, ${reason}, ${stt ? stt.engine : 'no-stt'} ${sttMs} ms${speculative ? ' speculative' : ''}, close->event ${closeToEventMs} ms, wake ${wakeConfirmed ? 'confirmed' : 'unconfirmed'})`);
  await postHaEvent('nest_headless_speech', {
    entity_id: entityId, camera: entityId.replace(/^camera\./, ''), keyword: c.keyword,
    utterance_id: utteranceId,
    text, duration_ms: durationMs, started_at: c.startedAt.toISOString(), ended_at: endedAt.toISOString(),
    reason: text ? reason : (reason === 'no_speech' ? 'no_speech' : reason),
    engine: stt ? stt.engine : null, stt_ms: sttMs, final: true, speculative, close_to_event_ms: closeToEventMs,
    wake_confirmed: wakeConfirmed,   // Whisper heard the wake phrase in the pre-roll (false = likely a spotter false alarm)
    wake_source: c.fromSegment ? 'transcript' : 'spotter',
    ...(c.followUp ? { opened_by: c.openedBy || null, open_reason: c.openReason || null } : {}),
    // other cameras that captured within 1.5 s of this one: the same voice reaching two mics
    // (kitchen + hallway both heard "hey kitchen" at 08:19); the brain dedupes on this
    concurrent_cameras: Object.entries(recentCaptureStart).filter(([cam, t0]) => cam !== entityId && Math.abs(t0 - c.t0) < 1500).map(([cam]) => cam.replace(/^camera\./, '')),
    // raw 16 kHz mono WAV, memory-held for 90 s, for a stronger recogniser on the brain
    audio_path: `/utterance/${utteranceId}.wav`, audio_ttl_s: (wakeConfirmed || c.followUp) ? UTTERANCE_KEEP_MS / 1000 : 90,
    // evidence (#21): the faces sampled for this capture, and when
    ...(seenFaces.length ? { frame_at: new Date(Math.max(...seenFaces.map((f) => f.at || 0)) || Date.now()).toISOString(),
      boxes: seenFaces.map((f) => ({ label: 'face', name: f.name, score: f.score, size_px: f.quality && f.quality.size_px, ...boxOf(f.box) })) } : {}),
  });
  // Identity follows as its own event so it can never delay the transcript.
  const quality = voiceQuality(c, all);
  const u = { camera: entityId, samples: all, quality, embedding: null, at: Date.now() };
  rememberUtterance(utteranceId, u, (wakeConfirmed || c.followUp) ? UTTERANCE_KEEP_MS : 90000);
  try {
    if (quality.reason === 'ok' || quality.speech_ms >= 800) u.embedding = embedVoice(all);
    const matches = u.embedding ? matchVoice(u.embedding) : [];
    // Only speech addressed to the house feeds the backlog or the auto room
    // samples: a spotter false alarm on background conversation (wake
    // unconfirmed, no follow-up window) is not something to keep.
    if (wakeConfirmed || c.followUp) considerVoiceForPending(entityId, u, matches, utteranceId);
    const seen = c.facesPromise ? await c.facesPromise.catch(() => []) : [];
    await postHaEvent('nest_headless_identity', {
      entity_id: entityId, camera: entityId.replace(/^camera\./, ''), utterance_id: utteranceId,
      speaker: { quality, matches }, faces: seen,
      frame_at: seen.length ? new Date(Math.max(...seen.map((f) => f.at || 0)) || Date.now()).toISOString() : null,
    });
  } catch (e) { console.warn('[nest_headless] identity failed:', e.message); }
}

const lastKeywordMs = {};
const audioStats = {};   // per camera: chunks, lastRms, rate, resampledLen, hits, lastError

// ---- transcript wake path (wake_by_transcript). Speech segments from the
// microphone (segments.js) become captures judged on their transcript in
// finishSpeechCapture: wake phrase at the head -> keyword + speech events;
// inside an open conversation window (POST /listen ... mode=conversation)
// -> the reply; otherwise dropped, nothing kept or logged. While a segment's
// transcript is pending the spotter stays quiet for that camera, and a
// spotter/listen capture resets the tracker, so each utterance is reported once.
const segTrackers = {}, segPending = {}, convo = {};
function segStat(entityId, key) { const s = audioStats[entityId]; if (s) s[key] = (s[key] || 0) + 1; }
// Two brakes (1.14.1), after a noisy hour produced 767 segments and every
// one a recogniser call: at most SEG_RATE_MAX transcriptions per camera per
// minute outside a reply window, and a pause of SEG_PAUSE_MS whenever the
// recogniser servers have failed SEG_FAIL_STREAK times in a row (they were
// timing out under memory pressure and the segments kept coming).
const SEG_RATE_MAX = 8, SEG_PAUSE_MS = 60000, SEG_FAIL_STREAK = 3;
const segRecent = {}, segPausedUntil = {}, segLastBrakeLog = {};
let sttFailStreak = 0;
function segBrake(entityId, key, why) {
  segStat(entityId, key);
  const now = Date.now();
  if (now - (segLastBrakeLog[entityId] || 0) > 300000) { segLastBrakeLog[entityId] = now; console.warn(`[nest_headless] segment path on ${entityId} ${why}`); }
}
function segFeed(entityId, chunk, rms) {
  const tr = segTrackers[entityId] || (segTrackers[entityId] = new SegmentTracker({ gapChunks: Math.max(2, Math.ceil(cfg.speechSilenceMs / 250)), maxChunks: cfg.speechMaxSeconds * 4 }));
  if (speechCap[entityId]) { tr.reset(); return; }   // a spotter or /listen capture owns the audio
  const seg = tr.feed(chunk, rms);
  if (!seg) return;
  const now = Date.now();
  const w = convo[entityId] && convo[entityId].until > now ? convo[entityId] : null;
  if (!w) {
    if (sttFailStreak >= SEG_FAIL_STREAK && !(segPausedUntil[entityId] > now)) segPausedUntil[entityId] = now + SEG_PAUSE_MS;
    if (segPausedUntil[entityId] > now) return segBrake(entityId, 'segments_paused', `paused ${SEG_PAUSE_MS / 1000}s: recogniser servers failing`);
    const recent = (segRecent[entityId] || []).filter((t) => now - t < 60000);
    if (recent.length >= SEG_RATE_MAX) { segRecent[entityId] = recent; return segBrake(entityId, 'segments_throttled', `throttled: over ${SEG_RATE_MAX} segments a minute (a noisy room?)`); }
    recent.push(now); segRecent[entityId] = recent;
  }
  // The same sentence reaching two microphones: whichever camera is already
  // capturing or deciding on it (started within 1.5 s) owns it; this copy is
  // dropped unheard rather than spending a second recogniser call.
  const twin = Object.entries(recentCaptureStart).find(([cam, t0]) => cam !== entityId && Math.abs(t0 - seg.startedMs) < 1500 && (speechCap[cam] || segPending[cam]));
  if (twin) { segStat(entityId, 'segments_duplicate'); return; }
  segStat(entityId, 'segments');
  recentCaptureStart[entityId] = seg.startedMs;
  segPending[entityId] = true;
  const c = { keyword: w ? 'follow-up' : null, chunks: seg.chunks, keepFrom: 0, startedAt: new Date(seg.startedMs), t0: seg.startedMs, floor: seg.floor,
    followUp: !!w, openedBy: w ? w.openedBy : null, openReason: w ? w.reason : null, windowOpenedAt: w ? w.openedAt : null,
    fromSegment: true, voicedMs: seg.voicedMs, spoke: true, facesPromise: null };
  finishSpeechCapture(entityId, c, 'silence')
    .catch((e) => console.warn('[nest_headless] segment failed:', e.message))
    .finally(() => { segPending[entityId] = false; });
}
function openConversation(entityId, seconds, openedBy, reason) {
  const w = { openedAt: Date.now(), until: Date.now() + seconds * 1000, openedBy, reason };
  convo[entityId] = w;
  setTimeout(() => { if (convo[entityId] === w) { delete convo[entityId]; console.log(`[nest_headless] conversation window on ${entityId} closed: nobody spoke`); } }, seconds * 1000 + 250).unref();
  return w;
}
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
    if (cfg.wakeByTranscript) segFeed(entityId, f32, st0.lastRms);
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
    // Idle refresh: a spotter stream that had run for an hour with no
    // detection (so no reset) stopped firing on clearly audible wake phrases
    // that a fresh stream on the same audio caught at once. Replace the
    // stream after 10 minutes without a detection, only during quiet and
    // never while a capture is open, so a phrase is never cut.
    const nowMs = Date.now();
    st.bornMs = st.bornMs || nowMs;
    if (nowMs - st.bornMs > 600000 && st0.lastRms < 0.01 && !speechCap[entityId]) {
      st.s = k.spotter.createStream(); st.bornMs = nowMs; st0.streamRefreshes = (st0.streamRefreshes || 0) + 1;
    }
    st.s.acceptWaveform({ samples: spot, sampleRate: 16000 });
    while (k.spotter.isReady(st.s)) {
      k.spotter.decode(st.s); st0.decodes = (st0.decodes || 0) + 1;
      const r = k.spotter.getResult(st.s);
      if (r && r.keyword) {
        k.spotter.reset(st.s); st.bornMs = Date.now();
        st0.lastKeyword = r.keyword; st0.lastKeywordAt = new Date().toISOString();
        const now = Date.now();
        if (speechCap[entityId]) continue;                       // capture in progress: no re-trigger
        if (segPending[entityId]) continue;                      // a transcript decision on this audio is in flight
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

// The page's motion mask: cat surfaces, passage zones (named "passage:<name>",
// never cat surfaces) and activity zones (reported per tick, never a hit).
function roisFor(entityId) {
  const passages = cfg.watchPassages[entityId] || [];
  return (cfg.watchRois[entityId] || [])
    .concat(passages.map((p) => ({ name: 'passage:' + p.name, pts: p.pts, x: p.x, y: p.y, w: p.w, h: p.h })))
    // With passages, ANY motion in the frame must reach the tracker, or a
    // person walking between doorways goes unseen, their track expires and
    // they reappear inside the next threshold as a new track "emerging from
    // the room" (three toilet "out"s in ten minutes on 3 Sept). Low threshold:
    // a distant person is ~1-2% of the frame.
    .concat(passages.length ? [{ name: 'passage:_frame', x: 0, y: 0, w: 1, h: 1, minPct: 1.2 }] : [])
    .concat((cfg.watchActivityZones[entityId] || []).map((z) => ({ name: z.name, pts: z.pts, x: z.x, y: z.y, w: z.w, h: z.h, activity: true })));
}
// Hot-apply a zone change on a live watch: restart the page loop with the new
// mask, forget trackers/zone references. Streams stay up.
async function applyZones(entityId) {
  const mgr = watchMgr[entityId];
  if (!mgr || !mgr.page || !mgr.ready) return false;
  const page = mgr.page;
  if (!mgr.activityExposed && (cfg.watchActivityZones[entityId] || []).length) {
    await page.exposeFunction('__activityNode', (pcts) => { try { onActivity(entityId, pcts); } catch (e) { /* ignore */ } });
    mgr.activityExposed = true;
  }
  await page.evaluate(() => { if (window.__watchTimer) { clearInterval(window.__watchTimer); window.__watchTimer = null; } });
  const rois = roisFor(entityId);
  if (rois.length) {
    await page.evaluate((src) => { window.__grabFrame = eval('(' + src + ')'); }, fns.grabFrame.toString());
    await page.evaluate(fns.startWatchLoop, { intervalMs: mgr.intervalSec * 1000, rois, diffPct: cfg.watchDiffPct, quality: cfg.jpegQuality });
  }
  mgr.tracker = null; mgr.zones = {}; delete activityState[entityId];
  console.log(`[nest_headless] zones applied on ${entityId}: ${(cfg.watchRois[entityId] || []).length} surfaces, ${(cfg.watchPassages[entityId] || []).length} passages, ${(cfg.watchClassifyZones[entityId] || []).length} state, ${(cfg.watchActivityZones[entityId] || []).length} activity`);
  return true;
}
async function runWatch(entityId, intervalSec) {
  const mgr = watchMgr[entityId] = { ready: false, hits: 0, lastHitMs: 0, lastError: null, page: null, intervalSec };
  const surfaces = cfg.watchRois[entityId] || [];
  const rois = roisFor(entityId);
  // No ROIs is fine: the stream still serves instant snapshots and classify
  // ticks - there is just no surface-motion event source for this camera.
  for (;;) {
    let page = null, session = null, classifyTimer = null, heartbeatTimer = null, zoneTimer = null;
    try {
      const browser = await getBrowser();
      page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${cfg.port}/blank`);
      await page.exposeFunction('__watchHitNode', (payload) =>
        watchHit(entityId, payload).catch((e) => console.warn('[nest_headless] watch hit failed:', e.message)));
      if ((cfg.watchActivityZones[entityId] || []).length) {
        await page.exposeFunction('__activityNode', (pcts) => { try { onActivity(entityId, pcts); } catch (e) { /* ignore */ } });
        mgr.activityExposed = true;
      } else mgr.activityExposed = false;
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
      if (cfg.watchClassifySeconds > 0 && (cfg.watchClassifyZones[entityId] || []).length) {
        zoneTimer = setInterval(() => zoneClassifyTick(entityId, mgr).catch((e) => console.warn(`[nest_headless] zone tick ${entityId}: ${e.message}`)), ZONE_TICK_MS);
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
      // A camera switched off in the vendor app answers FAILED_PRECONDITION to
      // every offer; each retry is a Google command against that camera's
      // quota and a log line, so back off to 5 minutes for that case.
      mgr.retryMs = /not available for streaming|FAILED_PRECONDITION/.test(e.message) ? 300000 : 30000;
      console.warn(`[nest_headless] watch ${entityId} down (${e.message}); retrying in ${mgr.retryMs / 1000}s`);
    } finally {
      try { if (classifyTimer) clearInterval(classifyTimer); } catch (e) { /* ok */ }
      try { if (zoneTimer) clearInterval(zoneTimer); } catch (e) { /* ok */ }
      try { if (heartbeatTimer) clearInterval(heartbeatTimer); } catch (e) { /* ok */ }
      try { if (session) session.close(); } catch (e) { /* ok */ }
      try { if (page) await page.close(); } catch (e) { /* ok */ }
    }
    await sleep(mgr.retryMs || 30000);
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
  // Sensitive routes - opening a listening window, identity, raw audio -
  // are loopback-only unless the caller presents the API token (Hearth #10).
  // Snapshots, frames, detection and status stay LAN-open for HA.
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const loopback = ip === '127.0.0.1' || ip === '::1';
  const sensitive = parts[0] === 'listen' || parts[0] === 'identity' || parts[0] === 'utterance' || parts[0] === 'audiodebug' || parts[0] === 'training' || (parts[0] === 'zones' && req.method !== 'GET');
  if (sensitive && !loopback) {
    const auth = req.headers.authorization || '';
    if (!cfg.apiToken || auth !== `Bearer ${cfg.apiToken}`) {
      console.warn(`[nest_headless] DENIED ${req.method} ${url.pathname} from ${ip} (${cfg.apiToken ? 'bad or missing token' : 'loopback only'}) at ${new Date().toISOString()}`);
      res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, reason: 'forbidden' }));
    }
  }

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
        cpus: os.cpus().length, nice: os.getPriority(), load: os.loadavg().map((v) => +v.toFixed(2)), loop_lag_ms: loopLagMs,
        audio: audioStats, capturing: Object.keys(speechCap),
        conversations: Object.fromEntries(Object.entries(convo).filter(([, w]) => w.until > Date.now()).map(([k, w]) => [k.replace(/^camera\./, ''), new Date(w.until).toISOString()])),
        wake_by_transcript: cfg.wakeByTranscript,
        watches: Object.fromEntries(Object.entries(watchMgr).map(([k, m]) => [k, {
          ready: m.ready, hits: m.hits, startedAt: m.startedAt, lastError: m.lastError,
          verdictWindow: (m.verdicts || []).join(''), sustainedOpen: !!m.sustainedOpen,
          passages: (cfg.watchPassages[k] || []).map((p) => p.name), tracks: m.tracker ? m.tracker.tracks.length : 0,
          zones: Object.fromEntries(Object.entries(m.zones || {}).map(([z, s]) => [z, { state: s.state, score: s.score, model: !!s.model, diff: s.diff, reference_since: s.refSince ? new Date(s.refSince).toISOString() : null, last_change: s.lastChangeMs ? new Date(s.lastChangeMs).toISOString() : null }])),
          activity: Object.fromEntries(Object.entries(activityState[k] || {}).map(([z, a]) => [z, { state: a.state, mean_pct: a.lastMean, since: new Date(a.since).toISOString() }])),
        }])),
      }, null, 2));
      return;
    }
    if (parts[0] === 'latest' && parts[1]) {
      serveFile(res, cameraEntity(parts[1].replace(/\.jpg$/, '')));
      return;
    }
    // ---- evidence by reference (#21)
    // GET /archive/<camera>/<iso|stamp|epoch-ms>.jpg[?within=ms] -> the frame
    // nearest that time (memory ring, event archive, heartbeat archive),
    // with X-Frame-At / X-Frame-Source / X-Frame-Distance-Ms; 404 if none within.
    if (parts[0] === 'archive' && parts[1] && parts[2]) {
      const t = evidence.parseTime(parts[2]);
      if (t === null) { res.writeHead(400); return res.end('bad time'); }
      const within = Math.max(1000, Math.min(3600000, Number(url.searchParams.get('within')) || 120000));
      const f = await frameNear(cameraEntity(parts[1]), t, within);
      if (!f) { res.writeHead(404); return res.end('no frame within range'); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': f.jpg.length, 'X-Frame-At': new Date(f.t).toISOString(), 'X-Frame-Source': f.source, 'X-Frame-Distance-Ms': String(f.dt), 'Cache-Control': 'max-age=86400' });
      return res.end(f.jpg);
    }
    // GET /look/zones/<camera>/<zone>/<time>.jpg -> the before|after composite nearest that time
    if (parts[0] === 'look' && parts[1] === 'zones' && parts[2] && parts[3] && parts[4]) {
      if (!cfg.samplesDir || !/^[a-z0-9_-]{1,32}$/i.test(parts[3])) { res.writeHead(404); return res.end('no zone evidence'); }
      const t = evidence.parseTime(parts[4]);
      if (t === null) { res.writeHead(400); return res.end('bad time'); }
      const ix = sampleIndex(cameraEntity(parts[2]), '_zones/' + parts[3]);
      const n = evidence.nearestName(await ix.load(), t);
      if (!n || n.dt > 600000) { res.writeHead(404); return res.end('no zone evidence within range'); }
      const buf = await require('fs/promises').readFile(path.join(ix.dir, n.name));
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'X-Frame-At': new Date(n.t).toISOString(), 'X-Frame-Distance-Ms': String(n.dt), 'Cache-Control': 'max-age=86400' });
      return res.end(buf);
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
      // is still in memory (24 h for speech addressed to the house, else 90 s;
      // gone on restart); never written to disk here
      const u = utterances.get(parts[1].replace(/\.wav$/, ''));
      if (!u || !u.samples) { res.writeHead(404); return res.end('no such utterance (expired, or the service restarted)'); }
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
    if (parts[0] === 'zones') {
      // Zone editor API (the app, admin-only there). GET is open; PUT/DELETE need
      // loopback or the API token. PUT {cameras: {<camera>: {surfaces?, passages?,
      // state?, activity?}}} replaces the given kinds for the given cameras,
      // saves zones.json and hot-applies to live watches (no restart).
      if (req.method === 'GET') {
        const j = zonesToJson();
        j.watched = Object.keys(watchMgr).map((k) => k.replace(/^camera\./, ''));
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(j));
      }
      if (req.method === 'PUT') {
        const body = await readJsonBody(req);
        const cams = body && body.cameras;
        if (!cams || typeof cams !== 'object') { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, reason: 'cameras object required' })); }
        const applied = [];
        try {
          // validate everything first, then commit
          const parsed = {};
          for (const [camName, kinds] of Object.entries(cams)) {
            const cam = cameraEntity(camName);
            parsed[cam] = {};
            for (const [kind, key] of Object.entries(ZONE_KINDS)) {
              if (kinds[kind] === undefined) continue;
              if (!Array.isArray(kinds[kind])) throw new Error(`${camName}.${kind} must be an array`);
              parsed[cam][key] = kinds[kind].map((z) => zoneFromJson(z, kind));
            }
          }
          for (const [cam, byKey] of Object.entries(parsed)) {
            for (const [key, list] of Object.entries(byKey)) { if (list.length) cfg[key][cam] = list; else delete cfg[key][cam]; }
          }
          saveZonesFile(Object.fromEntries(Object.entries(parsed).map(([cam]) => [cam.replace(/^camera\./, ''), zonesToJson().cameras[cam.replace(/^camera\./, '')] || {}])));
          for (const cam of Object.keys(parsed)) { if (await applyZones(cam)) applied.push(cam.replace(/^camera\./, '')); }
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, reason: e.message }));
        }
        console.log(`[nest_headless] ZONES updated from ${ip}: ${Object.keys(cams).join(', ')} (applied live: ${applied.join(', ') || 'none'})`);
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, applied, ...zonesToJson() }));
      }
      res.writeHead(405); return res.end('method not allowed');
    }
    if (parts[0] === 'listen' && parts[1] && req.method === 'DELETE') {
      const entityId = cameraEntity(parts[1]);
      const had = !!convo[entityId]; delete convo[entityId];
      res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, camera: entityId.replace(/^camera\./, ''), closed: had }));
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
      // mode=conversation (needs wake_by_transcript): instead of one capture
      // with its own end-pointing, open a window (up to 60 s) in which the
      // next speech segment on this microphone is the reply - the person can
      // pause, cough, start again. One reply closes it; DELETE closes it early
      // (do that before the speaker plays, or the house hears itself).
      if (url.searchParams.get('mode') === 'conversation') {
        if (!cfg.wakeByTranscript) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, reason: 'wake_by_transcript_off' })); }
        const secs = Math.max(1, Math.min(60, parseFloat(url.searchParams.get('seconds')) || 10));
        openConversation(entityId, secs, ip, (url.searchParams.get('reason') || '').slice(0, 60) || null);
        console.log(`[nest_headless] LISTEN conversation window ${secs}s on ${entityId} from ${ip}${url.searchParams.get('reason') ? ' reason=' + url.searchParams.get('reason').slice(0, 60) : ''} at ${new Date().toISOString()}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true, camera: entityId.replace(/^camera\./, ''), seconds: secs, mode: 'conversation' }));
      }
      const seconds = Math.max(1, Math.min(30, parseFloat(url.searchParams.get('seconds')) || 8));
      startSpeechCapture(entityId, 'follow-up', st.ring || [], { followUp: true, giveUpMs: seconds * 1000 });
      speechCap[entityId].openedBy = ip;   // carried on the event as opened_by so the brain can verify the source per capture (Hearth #10)
      speechCap[entityId].openReason = (url.searchParams.get('reason') || '').slice(0, 60) || null;
      console.log(`[nest_headless] LISTEN follow-up window ${seconds}s on ${entityId} from ${ip}${url.searchParams.get('reason') ? ' reason=' + url.searchParams.get('reason').slice(0, 60) : ''} at ${new Date().toISOString()}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, camera: entityId.replace(/^camera\./, ''), seconds }));
    }
    // ---- a brain's training crops, for review (#24): read-only listing and
    // files, plus DELETE of a single crop so a wrong label is gone before the
    // next retrain. The brain writes them; the add-on never does.
    if (parts[0] === 'training') {
      const root = cfg.trainingDir;
      const safe = (s) => typeof s === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(s) && !s.startsWith('.');
      if (!root || !fs.existsSync(root)) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, reason: 'no_training_dir' })); }
      const fsp = require('fs/promises');
      if (req.method === 'GET' && !parts[1]) {
        const sets = {};
        for (const key of (await fsp.readdir(root)).filter(safe)) {
          const kd = path.join(root, key); if (!(await fsp.stat(kd)).isDirectory()) continue;
          sets[key] = {};
          for (const label of (await fsp.readdir(kd)).filter(safe)) {
            const ld = path.join(kd, label); if (!(await fsp.stat(ld)).isDirectory()) continue;
            sets[key][label] = (await fsp.readdir(ld)).filter((f) => /\.jpe?g$/i.test(f)).length;
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ root, sets }));
      }
      if (!safe(parts[1]) || (parts[2] && !safe(parts[2])) || (parts[3] && !safe(parts[3]))) { res.writeHead(400); return res.end('bad path'); }
      if (req.method === 'GET' && parts[1] && parts[2] && !parts[3]) {
        const ld = path.join(root, parts[1], parts[2]);
        if (!fs.existsSync(ld)) { res.writeHead(404); return res.end('no such label'); }
        const files = (await fsp.readdir(ld)).filter((f) => /\.jpe?g$/i.test(f)).sort();
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ key: parts[1], label: parts[2], files: files.map((f) => ({ file: f, url: `/training/${parts[1]}/${parts[2]}/${f}` })) }));
      }
      if (parts[1] && parts[2] && parts[3] && /\.jpe?g$/i.test(parts[3])) {
        const f = path.join(root, parts[1], parts[2], parts[3]);
        if (!fs.existsSync(f)) { res.writeHead(404); return res.end('no such crop'); }
        if (req.method === 'GET') { const buf = await fsp.readFile(f); res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400' }); return res.end(buf); }
        if (req.method === 'DELETE') { await fsp.unlink(f); console.log(`[nest_headless] TRAINING crop dropped ${parts[1]}/${parts[2]}/${parts[3]} from ${ip}`); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); }
      }
      res.writeHead(404); return res.end('unknown training route');
    }
    if (parts[0] === 'identity') {
      if (req.method === 'GET' && !parts[1]) {
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(identitySummary()));
      }
      // ---- verification backlog (#16)
      if (parts[1] === 'pending') {
        if (req.method === 'GET' && !parts[2]) {
          const r = pending.list({ kind: url.searchParams.get('kind') || null, camera: url.searchParams.get('camera') || null, limit: Number(url.searchParams.get('limit')) || 50 });
          r.samples = r.samples.map((m) => ({ id: m.id, kind: m.kind, camera: m.camera, t: m.t, utterance_id: m.utterance_id, matches: m.matches, quality: m.quality, size_px: m.size_px, speech_ms: m.speech_ms, media_url: `/identity/pending/${m.id}/media` }));
          res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(r));
        }
        if (req.method === 'GET' && parts[2] && parts[3] === 'media') {
          const m = pending.mediaPath(parts[2]);
          if (!m) { res.writeHead(404); return res.end('no such sample'); }
          const buf = fs.readFileSync(m.file);
          res.writeHead(200, { 'Content-Type': m.type, 'Content-Length': buf.length }); return res.end(buf);
        }
        if (req.method === 'POST' && parts[2] && parts[3] === 'label') {
          const body = await readJsonBody(req);
          const r = enrolPending(parts[2], String(body.name || ''));
          res.writeHead(r.ok ? 200 : (r.reason === 'unknown_sample' ? 404 : 400), { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(r));
        }
        if (req.method === 'POST' && parts[2] && parts[3] === 'unknown') {
          const ok = pending.markUnknown(parts[2]);
          if (ok) { console.log(`[nest_headless] IDENTITY pending ${parts[2]} marked not-household`); notePendingCount(); }
          res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok, pending: pending.count() }));
        }
        if (req.method === 'POST' && parts[2] && parts[3] === 'not_person') {
          // a false face (poster, reflection, the cat) or non-speech (TV, a dog): kept as a hard negative (#18)
          const ok = pending.markNotPerson(parts[2]);
          if (ok) { console.log(`[nest_headless] IDENTITY pending ${parts[2]} marked not a person (${pending.negativeCount()} negatives)`); notePendingCount(); }
          res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok, pending: pending.count(), negatives: pending.negativeCount() }));
        }
        if (req.method === 'DELETE' && parts[2]) {
          const ok = pending.remove(parts[2]);
          if (ok) notePendingCount();
          res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok, pending: pending.count() }));
        }
        res.writeHead(404); return res.end('unknown pending route');
      }
      // ---- hard negatives (#18): "not a person" samples, kept until deleted
      if (parts[1] === 'negatives') {
        if (req.method === 'GET' && !parts[2]) {
          res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ count: pending.negativeCount(), samples: pending.listNegatives() }));
        }
        if (req.method === 'DELETE' && parts[2]) {
          const ok = pending.removeNegative(parts[2]);
          res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok, negatives: pending.negativeCount() }));
        }
        res.writeHead(404); return res.end('unknown negatives route');
      }
      // ---- the corpus for review (#24): /identity/<name>/samples[/<id>[/media]] and /identity/cat/<name>/samples...
      {
        const isCat = parts[1] === 'cat' && parts[2] && parts[3] === 'samples';
        const reserved = ['pending', 'negatives', 'voice', 'face', 'cat', 'who'];
        const isPerson = parts[1] && !reserved.includes(parts[1]) && parts[2] === 'samples';
        if (isCat || isPerson) {
          const name = String(isCat ? parts[2] : parts[1]).toLowerCase();
          const id = isCat ? parts[4] : parts[3], tail = isCat ? parts[5] : parts[4];
          if (req.method === 'GET' && !id) {
            const list = listSamples(name);
            if (!list) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, reason: 'unknown' })); }
            const wanted = isCat ? list.filter((s) => s.kind === 'cat') : list.filter((s) => s.kind !== 'cat');
            res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ name, samples: wanted, kept_media: cfg.identityKeepSamples }));
          }
          if (req.method === 'GET' && id && tail === 'media') {
            const m = sampleMedia(name, id);
            if (!m) { res.writeHead(404); return res.end('no media for this sample'); }
            const buf = await require('fs/promises').readFile(m.file);
            res.writeHead(200, { 'Content-Type': m.type, 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=86400' }); return res.end(buf);
          }
          if (req.method === 'DELETE' && id && !tail) {
            const r = deleteSample(name, id);
            res.writeHead(r.ok ? 200 : 404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(r));
          }
          res.writeHead(404); return res.end('unknown samples route');
        }
      }
      if (req.method === 'GET' && parts[1] === 'who' && parts[2]) {
        // who is in view right now: one frame, faces matched against enrolled people
        const r = await facesForCamera(cameraEntity(parts[2]));
        // cats in the same frame (#23), when the frame came back
        let cats = [];
        if (r.jpg) { try { cats = (await catsInJpeg(r.jpg, { camera: cameraEntity(parts[2]) })).cats.map(publicCat); } catch (e) { /* faces still answer */ } }
        res.writeHead(r.ok ? 200 : 404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: r.ok, reason: r.reason, camera: parts[2], at: new Date().toISOString(), faces: r.faces.map(publicFace), cats }));
      }
      // ---- cats (#23): the same identity flow for the household's cats
      if (req.method === 'POST' && parts[1] === 'cat' && parts[2] === 'enrol') {
        const body = await readJsonBody(req);
        const cam = body.camera ? cameraEntity(body.camera) : null;
        let found;
        if (body.image_b64) {
          // a labelled crop or a photo from the app: the cat is the picture (no frame, so unsized)
          let jpg = Buffer.from(String(body.image_b64).replace(/^data:[^,]*,/, ''), 'base64');
          if (jpg.length < 100) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, accepted: false, reason: 'bad_image' })); }
          const sharpM = getSharp();
          if (!sharpM) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, accepted: false, reason: 'no_sharp' })); }
          try {
            jpg = await sharpM(jpg).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer();
            // if the house detector finds the cat in the photo, describe that box; else the whole picture
            const d = await infer.detectCats(jpg, { conf: 0.5 }).catch(() => null);
            const boxes = (d || []).filter((x) => x.cls === 15 || x.cls === 16).sort((a, b) => b.box.w * b.box.h - a.box.w * a.box.h);
            found = boxes.length ? { photo: { ...(await catid.describeInJpeg(sharpM, jpg, boxes[0].box, { withCrop: false })), sized: false } } : { photo: await catid.describeImage(sharpM, jpg) };
          } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, accepted: false, reason: 'bad_image: ' + e.message })); }
        } else if (cam) {
          const mgr = watchMgr[cam];
          if (!mgr || !mgr.ready || !mgr.page) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, accepted: false, reason: 'camera_not_watched' })); }
          const shot = await mgr.page.evaluate(fns.grabFrame, { quality: cfg.jpegQuality, crop: null });
          const jpg = Buffer.from(shot.dataUrl.split(',')[1], 'base64');
          noteFrame(cam, jpg);
          found = await catsInJpeg(jpg, { camera: cam });
        } else { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, accepted: false, reason: 'no_camera_or_image' })); }
        const r = enrolCat(String(body.name || ''), cam || 'upload', found, Number.isInteger(body.index) ? body.index : undefined);
        res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(r));
      }
      if (req.method === 'DELETE' && parts[1] === 'cat' && parts[2]) {
        const r = forgetPerson(parts[2]);   // a cat's samples live in the same store, under its name
        res.writeHead(r.ok ? 200 : 404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(r));
      }
      if (req.method === 'GET' && parts[1] === 'cat' && parts[2]) {
        if (!enrolled) loadEnrolled();
        const r = enrolledCats[parts[2].toLowerCase()] ? catSummary(parts[2].toLowerCase()) : null;
        res.writeHead(r ? 200 : 404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(r || { ok: false, reason: 'unknown' }));
      }
      if (req.method === 'POST' && parts[1] === 'face' && parts[2] === 'enrol') {
        const body = await readJsonBody(req);
        const cam = body.camera ? cameraEntity(body.camera) : null;
        // Hearth #9: a supplied image (JSON image_b64) instead of a live frame - for a frame the
        // brain already holds and the owner has identified. Same detector, rules, refusals, storage.
        let found;
        if (body.image_b64) {
          let jpg = Buffer.from(String(body.image_b64).replace(/^data:[^,]*,/, ''), 'base64');
          if (jpg.length < 100) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, accepted: false, reason: 'bad_image' })); }
          // phone photos: honour EXIF rotation and cap at 1600 px before detection (a 12 MP
          // upload decoded raw is ~48 MB and spun the loop during onboarding, Hearth #17)
          const sharpM = getSharp();
          if (sharpM) jpg = await sharpM(jpg).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toBuffer().catch(() => jpg);
          found = await facesInBuffer(jpg, { minPx: 40 }).catch((e) => ({ ok: false, reason: 'bad_image: ' + e.message, faces: [] }));
          found.jpg = jpg;   // for the kept context crop (#24)
        } else if (cam) {
          found = await facesForCamera(cam, { minPx: 40 });
        } else { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, accepted: false, reason: 'no_camera_or_image' })); }
        const r = enrolFace(String(body.name || ''), cam || 'upload', found, Number.isInteger(body.index) ? body.index : undefined, body.pose);
        res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(r));
      }
      if (req.method === 'POST' && parts[1] === 'voice' && parts[2] === 'who') {
        // Who is speaking in an uploaded clip (#19): {audio_b64, format?} ->
        // {quality, matches, decisive}. Same bearer rule as the other identity
        // routes; the clip is matched in memory and not kept.
        const body = await readJsonBody(req);
        if (!body.audio_b64) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, reason: 'no_audio' })); }
        let samples;
        try { samples = await decodeUploadedAudio(Buffer.from(String(body.audio_b64).replace(/^data:[^,]*,/, ''), 'base64'), body.format); }
        catch (e) { res.writeHead(e.message === 'unsupported_format' ? 415 : 400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, reason: e.message === 'unsupported_format' || e.message === 'no_converter' ? e.message : 'bad_audio: ' + e.message })); }
        const r = identifyVoiceClip(samples);
        console.log(`[nest_headless] IDENTITY who from upload: ${r.matches[0] ? r.matches[0].name + ':' + r.matches[0].score : 'no match'} (${r.quality.speech_ms} ms voiced${r.decisive ? ', decisive' : ''}) from ${ip}`);
        res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(r));
      }
      if (req.method === 'POST' && parts[1] === 'voice' && parts[2] === 'enrol') {
        const body = await readJsonBody(req);
        const cam = body.camera ? cameraEntity(body.camera) : null;
        let r;
        if (body.audio_b64) {   // onboarding from the phone (#16): a clip of 3-10 s with the phrase spoken (WAV, or m4a/caf via the host converter)
          let samples = null;
          try { samples = await decodeUploadedAudio(Buffer.from(String(body.audio_b64).replace(/^data:[^,]*,/, ''), 'base64'), body.format); }
          catch (e) { r = { ok: false, accepted: false, reason: e.message === 'unsupported_format' || e.message === 'no_converter' ? e.message : 'bad_audio: ' + e.message }; }
          if (samples) r = enrolVoiceFromAudio(String(body.name || ''), samples, body.phrase ? String(body.phrase).slice(0, 120) : null, cam);
        } else {
          const u = body.utterance_id ? utterances.get(body.utterance_id) : (cam ? latestUtterance(cam) : null);
          r = enrolVoice(String(body.name || ''), u);
        }
        res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(r));
      }
      if (req.method === 'GET' && parts[1] && !parts[2]) {   // per-person summary for the app
        if (!enrolled) loadEnrolled();
        const name = parts[1].toLowerCase();
        if (!enrolled[name] && !enrolledFaces[name]) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, reason: 'unknown' })); }
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, ...personSummary(name) }));
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
  // read the identity dir (possibly a network share) at boot, not during the first conversation
  setTimeout(() => { try { loadEnrolled(); } catch (e) { /* no identity dir yet */ } }, 3000).unref();
  if (faces.hasModels(FACE_MODELS_DIR())) faces.getSessions(FACE_MODELS_DIR()).catch(() => {});
  for (const [entityId, interval] of Object.entries(cfg.watches)) {
    runWatch(entityId, interval).catch((e) => console.error(`[nest_headless] watch ${entityId} crashed:`, e.message));
  }
});

process.on('SIGTERM', async () => {
  try { const b = await browserPromise; if (b) await b.close(); } catch (e) { /* ok */ }
  process.exit(0);
});
