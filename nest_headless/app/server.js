#!/usr/bin/env node
// nest_headless: server-side Nest camera stills via headless Chromium.
//
// Home Assistant relays WebRTC-only Nest cameras' live stream to the browser
// but never terminates the media itself, so camera.snapshot has no frame to
// return and hands back a placeholder. This add-on runs a real browser
// (headless Chromium) that opens the stream the same way the dashboard does,
// waits for it to ramp to full resolution, and turns a decoded frame into a
// JPEG.
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
  // also writes <camera>_crop.jpg for that region, a stable close-up that
  // makes small state changes trivial for vision models.
  crops: parseCrops(process.env.CROPS || ''),
  // When set, every capture also archives its crop as
  // <samplesDir>/<camera>/<timestamp>.jpg (capped): training data for the
  // tiny door-state classifier, gathered across lighting conditions.
  samplesDir: process.env.SAMPLES_DIR || '',
  samplesMax: intEnv('SAMPLES_MAX', 2000),
};

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
// candidates on these cameras). Chrome tolerates it, but patch anyway:
// proven form from the working browser control.
const patchFoundation = (sdp) => sdp.replace(/a=candidate: /g, 'a=candidate:0 ');
const patchCandidate = (c) => (typeof c === 'string' ? c.replace(/^candidate: /, 'candidate:0 ') : c);

// ------------------------------------------------------------ HA websocket
function haOfferSession(entityId, offerSdp, { onAnswer, onCandidate, onError }) {
  // Returns { close }. Closing the socket ends the HA-side session.
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
      // log codec support once; H.264 must be present for Nest
      const p = await b.newPage();
      const codecs = await p.evaluate(fns.videoCodecs);
      console.log('[nest_headless] receiver video codecs:', codecs.join(', '));
      if (!codecs.some((c) => /h264/i.test(c))) {
        console.error('[nest_headless] WARNING: this Chromium build lacks H.264, Nest video will not decode');
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

async function capture(entityId) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  let session = null;
  const timeoutMs = cfg.captureTimeoutSeconds * 1000;
  try {
    await page.goto('about:blank');
    const offerSdp = await page.evaluate(fns.initPeer);

    const answered = new Promise((resolve, reject) => {
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
    await answered;

    const shot = await page.evaluate(fns.waitAndCapture, {
      warmupFrames: cfg.warmupFrames,
      quality: cfg.jpegQuality,
      timeoutMs,
      crop: cfg.crops[entityId] || null,
    });

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
      if (cfg.samplesDir) archiveSample(entityId, cbuf);
      verdict = classify(entityId, cbuf); // null when no model is trained yet
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
    return { buf, meta };
  } finally {
    if (session) session.close(); // ends the HA/Google session -> frees quota slot
    try { await page.close(); } catch (e) { /* ok */ }
  }
}

function archiveSample(entityId, buf) {
  try {
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
  } catch (e) {
    console.warn('[nest_headless] sample archive failed:', e.message);
  }
}

async function captureCoalesced(entityId) {
  const s = state[entityId] || (state[entityId] = { lastCaptureMs: 0, inflight: null, lastMeta: null });
  if (s.inflight) return s.inflight; // coalesce concurrent requests: one Google command
  s.inflight = capture(entityId)
    .then((r) => { s.lastCaptureMs = Date.now(); s.lastMeta = r.meta; return r; })
    .finally(() => { s.inflight = null; });
  return s.inflight;
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
      }, null, 2));
      return;
    }
    if (parts[0] === 'latest' && parts[1]) {
      serveFile(res, cameraEntity(parts[1].replace(/\.jpg$/, '')));
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

server.listen(cfg.port, () => console.log(`[nest_headless] listening on :${cfg.port}`));

process.on('SIGTERM', async () => {
  try { const b = await browserPromise; if (b) await b.close(); } catch (e) { /* ok */ }
  process.exit(0);
});
