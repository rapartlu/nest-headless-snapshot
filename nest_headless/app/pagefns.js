// Page-side functions, evaluated inside Chromium.
// Shared by the add-on server and the local loopback test so the capture
// path exercised in tests is byte-identical to production.
//
// The handshake is exactly the one proven to work against this camera:
//   audio m-line, then video, then a data channel (application m-line).

const initPeer = async () => {
  const pc = new RTCPeerConnection();
  window.__pc = pc;
  window.__trackReady = new Promise((res) => {
    pc.ontrack = (ev) => {
      if (ev.track.kind === 'video') {
        res(ev.streams && ev.streams[0] ? ev.streams[0] : new MediaStream([ev.track]));
      }
      // the camera's microphone rides the same session - stash it for the
      // optional audio pipeline (keyword spotting)
      if (ev.track.kind === 'audio') window.__audioStream = new MediaStream([ev.track]);
    };
  });
  pc.addTransceiver('audio', { direction: 'recvonly' });   // order matters
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.createDataChannel('dataSendChannel');                 // application m-line
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await new Promise((res) => {
    if (pc.iceGatheringState === 'complete') return res();
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') res();
    });
    setTimeout(res, 8000); // send what we have if gathering stalls
  });
  return pc.localDescription.sdp;
};

const setRemoteAnswer = async (sdp) => {
  await window.__pc.setRemoteDescription({ type: 'answer', sdp });
  return window.__pc.iceConnectionState;
};

const addRemoteCandidate = async (cand) => {
  try { await window.__pc.addIceCandidate(cand); } catch (e) { /* tolerated */ }
};

const connectionState = () => ({
  ice: window.__pc ? window.__pc.iceConnectionState : 'none',
  pc: window.__pc ? window.__pc.connectionState : 'none',
});

// Wait for real decoded frames (requestVideoFrameCallback fires only when a
// frame has actually been decoded and composited — padding-only RTP never
// fires it), skip warmup frames, then draw to canvas and return a JPEG.
const waitAndCapture = async ({ warmupFrames = 3, quality = 0.85, timeoutMs = 20000, crop = null }) => {
  const stream = await Promise.race([
    window.__trackReady,
    new Promise((_, rej) => setTimeout(() => rej(new Error('no video track within timeout')), timeoutMs)),
  ]);
  const v = document.createElement('video');
  v.muted = true; v.autoplay = true; v.playsInline = true;
  v.srcObject = stream;
  document.body.appendChild(v);
  await v.play().catch(() => {});
  let frames = 0;
  // Google starts the session at 640x360 and switches to 1920x1080 a few
  // seconds in, once the sender has ramped up (the ramp is time-based, not
  // frame-based). Prefer the first HD frame; fall back to whatever resolution
  // we have if HD hasn't arrived in time.
  const hdMinWidth = 1280;
  // Ramp to HD typically lands in 2-3s; cap the wait so captures stay fast —
  // the cat deterrent needs reaction time more than it needs guaranteed 1080p.
  const hdWaitMs = Math.min(5000, timeoutMs * 0.6);
  const t0 = Date.now();
  await new Promise((res, rej) => {
    const to = setTimeout(
      () => rej(new Error(`no decoded video frames within ${timeoutMs}ms (got ${frames})`)), timeoutMs);
    const cb = () => {
      frames++;
      const warm = frames >= warmupFrames && v.videoWidth > 0;
      const hd = v.videoWidth >= hdMinWidth;
      if (warm && (hd || Date.now() - t0 > hdWaitMs)) { clearTimeout(to); res(); }
      else v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  });
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(v, 0, 0);
  // mean luma so the caller can reject an all-black frame (the failure mode
  // this whole add-on exists to eliminate: placeholder was mean luma 6.0)
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 40) { // sample every 10th pixel
    sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  }
  const meanLuma = sum / (d.length / 40);
  const dataUrl = c.toDataURL('image/jpeg', quality);
  // Optional fixed region of interest (fractions of frame: {x,y,w,h} in 0..1)
  // written alongside the full frame — a close-up makes small state changes
  // (a door ajar) trivial for a vision model where the full frame is marginal.
  let cropDataUrl = null;
  if (crop && crop.w > 0 && crop.h > 0) {
    const sx = Math.round(crop.x * c.width);
    const sy = Math.round(crop.y * c.height);
    const sw = Math.min(Math.round(crop.w * c.width), c.width - sx);
    const sh = Math.min(Math.round(crop.h * c.height), c.height - sy);
    const cc = document.createElement('canvas');
    cc.width = sw; cc.height = sh;
    cc.getContext('2d').drawImage(c, sx, sy, sw, sh, 0, 0, sw, sh);
    cropDataUrl = cc.toDataURL('image/jpeg', quality);
  }
  v.srcObject = null; v.remove();
  return { dataUrl, cropDataUrl, width: c.width, height: c.height, frames, meanLuma };
};

// ---- persistent watch mode -------------------------------------------------
// One long-lived stream per watched camera. HA extends the Google session
// server-side for as long as the peer connection stays open, so sampling
// frames locally is free: no per-check SDM command, no dial latency.

// Create the persistent <video> for this page's stream and wait for the HD
// ramp (same logic as waitAndCapture, but the element is kept).
const startWatchVideo = async ({ timeoutMs = 25000, warmupFrames = 3 }) => {
  const stream = await Promise.race([
    window.__trackReady,
    new Promise((_, rej) => setTimeout(() => rej(new Error('no video track within timeout')), timeoutMs)),
  ]);
  const v = document.createElement('video');
  v.muted = true; v.autoplay = true; v.playsInline = true;
  v.srcObject = stream;
  document.body.appendChild(v);
  await v.play().catch(() => {});
  let frames = 0;
  const hdMinWidth = 1280;
  const hdWaitMs = Math.min(6000, timeoutMs * 0.6);
  const t0 = Date.now();
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error(`no decoded frames within ${timeoutMs}ms`)), timeoutMs);
    const cb = () => {
      frames++;
      const warm = frames >= warmupFrames && v.videoWidth > 0;
      if (warm && (v.videoWidth >= hdMinWidth || Date.now() - t0 > hdWaitMs)) { clearTimeout(to); res(); }
      else v.requestVideoFrameCallback(cb);
    };
    v.requestVideoFrameCallback(cb);
  });
  window.__watchVideo = v;
  return { width: v.videoWidth, height: v.videoHeight, frames };
};

// Instant frame grab from the live watch video (no waiting, no dialing).
const grabFrame = ({ quality = 0.85, crop = null }) => {
  const v = window.__watchVideo;
  if (!v || !v.videoWidth) throw new Error('watch video not ready');
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(v, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 40) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  const meanLuma = sum / (d.length / 40);
  const dataUrl = c.toDataURL('image/jpeg', quality);
  let cropDataUrl = null;
  if (crop && crop.w > 0 && crop.h > 0) {
    const sx = Math.round(crop.x * c.width), sy = Math.round(crop.y * c.height);
    const sw = Math.min(Math.round(crop.w * c.width), c.width - sx);
    const sh = Math.min(Math.round(crop.h * c.height), c.height - sy);
    const cc = document.createElement('canvas');
    cc.width = sw; cc.height = sh;
    cc.getContext('2d').drawImage(c, sx, sy, sw, sh, 0, 0, sw, sh);
    cropDataUrl = cc.toDataURL('image/jpeg', quality);
  }
  return { dataUrl, cropDataUrl, width: c.width, height: c.height, frames: -1, meanLuma };
};

// Sample the stream every intervalMs, diff grayscale inside the given ROIs
// (fractions {x,y,w,h}), and report via window.__watchHitNode(payload) when
// the changed-pixel fraction in any ROI exceeds diffPct percent. Node side
// applies the cooldown; this loop just reports.
const startWatchLoop = ({ intervalMs = 4000, rois = [], diffPct = 4, quality = 0.85 }) => {
  const v = window.__watchVideo;
  if (!v) throw new Error('watch video not ready');
  const W = 320, H = 180;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  let prev = null;
  // Polygon zones: precompute a coverage mask per ROI once (ray-cast per
  // pixel of the 320x180 grid) so the diff loop only counts motion inside
  // the drawn shape, not the whole bounding box.
  const inPoly = (pts, px2, py2) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if ((yi > py2) !== (yj > py2) && px2 < ((xj - xi) * (py2 - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  for (const r of rois) {
    if (r.pts) {
      r.mask = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (inPoly(r.pts, (x + 0.5) / W, (y + 0.5) / H)) r.mask[y * W + x] = 1;
      }
    }
  }
  window.__watchTicks = 0;
  window.__watchTimer = setInterval(() => {
    try {
      if (!v.videoWidth) return;
      ctx.drawImage(v, 0, 0, W, H);
      const d = ctx.getImageData(0, 0, W, H).data;
      const g = new Float32Array(W * H);
      for (let i = 0; i < W * H; i++) {
        const j = i * 4;
        g[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
      }
      window.__watchTicks++;
      if (prev) {
        let best = null;
        window.__watchMaxPct = window.__watchMaxPct || 0;
        for (const r of rois) {
          const x0 = Math.floor(r.x * W), y0 = Math.floor(r.y * H);
          const x1 = Math.min(W, Math.ceil((r.x + r.w) * W)), y1 = Math.min(H, Math.ceil((r.y + r.h) * H));
          let changed = 0, total = 0;
          for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const i = y * W + x;
            if (r.mask && !r.mask[i]) continue;   // outside the polygon
            total++;
            if (Math.abs(g[i] - prev[i]) > 22) changed++;
          }
          const pct = total ? (changed / total) * 100 : 0;
          if (pct > window.__watchMaxPct) window.__watchMaxPct = Math.round(pct * 10) / 10;
          if (pct >= diffPct && (!best || pct > best.pct)) best = { roi: r.name || 'roi', pct: Math.round(pct * 10) / 10 };
        }
        if (best) {
          // page.evaluate serializes this function WITHOUT its module scope:
          // grabFrame must be pre-installed on window by the server (it was
          // not, and every hit threw ReferenceError into the catch below -
          // silently, for the watch feature's entire life until 2026-08-30).
          const shot = (window.__grabFrame || grabFrame)({ quality });
          window.__watchHits = (window.__watchHits || 0) + 1;
          window.__watchHitNode({ roi: best.roi, changedPct: best.pct, ...shot });
        }
      }
      prev = g;
    } catch (e) { /* keep looping */ }
  }, intervalMs);
  return true;
};

// Tap the camera microphone: mono PCM chunks (~1s) shipped to Node as
// base64 Int16 via window.__audioChunkNode(b64, sampleRate). Node resamples
// to 16k and runs the keyword spotter. Nothing is recorded anywhere.
const startWatchAudio = async () => {
  if (!window.__audioStream) return { ok: false, reason: 'no audio track' };
  const ctx = new AudioContext();
  await ctx.resume().catch(() => {});
  const src = ctx.createMediaStreamSource(window.__audioStream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  let buf = [];
  let len = 0;
  proc.onaudioprocess = (e) => {
    const ch = e.inputBuffer.getChannelData(0);
    buf.push(new Float32Array(ch)); len += ch.length;
    if (len >= ctx.sampleRate) {                    // ~1s chunks
      const all = new Float32Array(len);
      let o = 0; for (const b of buf) { all.set(b, o); o += b.length; }
      buf = []; len = 0;
      const i16 = new Int16Array(all.length);
      for (let i = 0; i < all.length; i++) i16[i] = Math.max(-32768, Math.min(32767, all[i] * 32768));
      let bin = ''; const u8 = new Uint8Array(i16.buffer);
      for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      if (window.__audioChunkNode) window.__audioChunkNode(btoa(bin), ctx.sampleRate);
    }
  };
  src.connect(proc); proc.connect(ctx.destination);
  window.__audioCtx = ctx;
  return { ok: true, sampleRate: ctx.sampleRate };
};

const watchState = () => ({
  ticks: window.__watchTicks || 0,
  hits: window.__watchHits || 0,
  maxPct: window.__watchMaxPct || 0,
  width: window.__watchVideo ? window.__watchVideo.videoWidth : 0,
  height: window.__watchVideo ? window.__watchVideo.videoHeight : 0,
  ice: window.__pc ? window.__pc.iceConnectionState : 'none',
});

const videoCodecs = () => {
  const caps = RTCRtpReceiver.getCapabilities('video');
  return caps ? caps.codecs.map((c) => c.mimeType) : [];
};

module.exports = { initPeer, setRemoteAnswer, addRemoteCandidate, connectionState, waitAndCapture, videoCodecs, startWatchVideo, grabFrame, startWatchLoop, startWatchAudio, watchState };
