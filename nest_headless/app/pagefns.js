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
  // Google starts the session at 640x360 and switches to 1920x1080 once
  // Chrome's TWCC-driven bandwidth estimate has ramped (a few seconds — the
  // ramp is time-based, not frame-based). Prefer the first HD frame; fall
  // back to whatever resolution we have if HD hasn't arrived in time.
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

const videoCodecs = () => {
  const caps = RTCRtpReceiver.getCapabilities('video');
  return caps ? caps.codecs.map((c) => c.mimeType) : [];
};

module.exports = { initPeer, setRemoteAnswer, addRemoteCandidate, connectionState, waitAndCapture, videoCodecs };
