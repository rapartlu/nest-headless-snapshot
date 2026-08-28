// Loopback test: exercises the production page functions (initPeer,
// setRemoteAnswer, waitAndCapture) against an in-page WebRTC sender fed by
// an animated canvas — including a simulated Google answer with EMPTY ICE
// FOUNDATIONS. Validates everything except the Google leg itself.
'use strict';
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const fns = require('../app/pagefns');

const patchFoundation = (sdp) => sdp.replace(/a=candidate: /g, 'a=candidate:0 ');
const blankFoundation = (sdp) => sdp.replace(/a=candidate:\S+ /g, 'a=candidate: ');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  try {
    const page = await browser.newPage();
    page.on('console', (m) => process.env.VERBOSE && console.log('page:', m.text()));
    await page.goto('about:blank');

    const codecs = await page.evaluate(fns.videoCodecs);
    console.log('receiver video codecs:', codecs.join(', '));

    const offer = await page.evaluate(fns.initPeer);
    const mlines = offer.split('\n').filter((l) => l.startsWith('m=')).map((l) => l.split(' ')[0]);
    console.log('offer m-lines:', mlines.join(' '));
    if (mlines.join(' ') !== 'm=audio m=video m=application') {
      throw new Error('WRONG M-LINE ORDER: ' + mlines.join(' '));
    }
    if (!offer.includes('transport-wide-cc')) {
      console.log('note: transport-cc extension line not found in offer (unexpected for Chrome)');
    }

    // in-page sender: animated canvas -> captureStream -> answer the offer
    const answer = await page.evaluate(async (offerSdp) => {
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 480;
      const ctx = canvas.getContext('2d');
      let t = 0;
      setInterval(() => {
        t++;
        ctx.fillStyle = `hsl(${(t * 7) % 360},80%,50%)`;
        ctx.fillRect(0, 0, 640, 480);
        ctx.fillStyle = '#fff'; ctx.font = '48px sans-serif';
        ctx.fillText('LOOPBACK ' + t, 40, 240);
      }, 100);
      const stream = canvas.captureStream(10);
      const pc1 = new RTCPeerConnection();
      window.__sender = pc1;
      await pc1.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      stream.getTracks().forEach((tr) => pc1.addTrack(tr, stream));
      const ans = await pc1.createAnswer();
      await pc1.setLocalDescription(ans);
      await new Promise((res) => {
        if (pc1.iceGatheringState === 'complete') return res();
        pc1.addEventListener('icegatheringstatechange', () => {
          if (pc1.iceGatheringState === 'complete') res();
        });
        setTimeout(res, 5000);
      });
      return pc1.localDescription.sdp;
    }, offer);

    // simulate Google's empty-foundation answer, then apply the production patch
    const blanked = blankFoundation(answer);
    const nBlank = (blanked.match(/a=candidate: /g) || []).length;
    console.log(`simulated ${nBlank} empty-foundation candidates in answer`);
    if (nBlank === 0) throw new Error('test setup: no candidates to blank');

    await page.evaluate(fns.setRemoteAnswer, patchFoundation(blanked));
    const shot = await page.evaluate(fns.waitAndCapture,
      { warmupFrames: 25, quality: 0.85, timeoutMs: 20000 });

    const buf = Buffer.from(shot.dataUrl.split(',')[1], 'base64');
    const out = path.join(__dirname, 'loopback.jpg');
    fs.writeFileSync(out, buf);
    console.log(`captured ${shot.width}x${shot.height}, ${shot.frames} frames, ` +
      `meanLuma ${shot.meanLuma.toFixed(1)}, ${buf.length} bytes -> ${out}`);

    // WebRTC senders start low-res and ramp as congestion control gains
    // confidence — by 25 frames the loopback should be at source resolution.
    if (shot.width < 320) throw new Error('resolution did not ramp: ' + shot.width);
    if (shot.frames < 25) throw new Error('too few decoded frames');
    if (shot.meanLuma < 10) throw new Error('frame is black — capture path broken');
    console.log('\nLOOPBACK TEST PASSED');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('LOOPBACK TEST FAILED:', e); process.exit(1); });
