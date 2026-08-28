# Nest Headless Snapshot

**Real still images from WebRTC-only Google Nest cameras, server-side, inside
Home Assistant** — plus the diagnostic story of *why* every ordinary
server-side WebRTC client fails against these cameras, and a probe you can run
to see it yourself.

## The problem

Newer Google Nest cameras are WebRTC-only (no RTSP, no HLS through the SDM
API). Home Assistant's Nest integration relays WebRTC signalling but never
touches media, so `camera.snapshot` on these cameras returns a black
placeholder frame. Pointing standard server-side WebRTC clients at them —
go2rtc, aiortc, and friends — gets a completed ICE + DTLS handshake and then
**video RTP packets with zero-byte payloads, forever** (bandwidth-probe
padding). Audio flows fine. Meanwhile Chrome on the same LAN and account
receives hundreds of frames within seconds.

## The diagnosis

Google's sender will not ramp past bandwidth probing unless the receiver
sends **transport-wide congestion control (TWCC) feedback** it trusts. Chrome
implements TWCC; aiortc and go2rtc (as of 1.9.x) do not generate TWCC
receiver feedback. PLI forcing and REMB spoofing alone change nothing.

`probe/` contains a single-binary Go client (pion/webrtc v4, whose default
interceptor chain *does* generate TWCC feedback) that demonstrates this in
about two minutes: with `transport-cc` negotiated and feedback flowing,
Google sends real H.264 immediately — in our measured runs the stream
switches from 640×360 to 1920×1080 within a few frames. Two additional
empirical requirements are baked into both the probe and the add-on:

1. **SDP m-line order must be audio, video, application** (data channel).
2. Google's SDP answer contains ICE candidates with an **empty foundation**
   (`a=candidate: ...`) which strict parsers reject — they must be patched
   before use.

## The add-on

`nest_headless/` is a Home Assistant local add-on that runs headless Chromium
(the client class proven to work), performs the browser handshake against
HA's own `camera/webrtc/offer` websocket API, waits for the stream to ramp to
HD, renders a frame, and serves/writes it as a JPEG:

```
GET /snapshot/<camera>              capture now (or cached if recent), JPEG
GET /snapshot/<camera>?fresh=1      always capture (one SDM command)
GET /snapshot/<camera>?fresh=1&format=json    capture, return metadata JSON
GET /latest/<camera>.jpg            last capture from disk
GET /            status JSON        GET /health   liveness
```

Files land atomically in `/config/www/nest/<camera>.jpg`, ready for
`llmvision.image_analyzer`'s `image_file`, notifications, or anything else.
Response headers and the JSON carry `meanLuma` (black-frame guard), size and
capture age. Concurrent requests for the same camera coalesce into a single
capture, so a burst of automations costs one SDM command.

Extras that grew out of real use:

- **Fixed-region crops** (`crops` option): per-camera regions of interest
  written as `<camera>_crop.jpg` alongside each frame — a stable close-up
  makes small state changes (a cupboard door ajar) far easier for any
  downstream model than the full fisheye frame.
- **Sample archiving** (`samples_dir` option): every capture's crop is also
  archived with a timestamp — effortless labelled-ish training data across
  lighting conditions.
- **Tiny on-device classifiers** (`app/classifier.js` + `tools/train_door_model.py`):
  logistic regression over a downscaled residual-vs-reference grayscale crop,
  trained offline in seconds, shipped as a JSON weights file in
  `/config/nest_models/<camera>.json`, hot-reloaded on change, evaluated in
  microseconds of pure JavaScript per capture. The verdict rides in the
  capture JSON (`classifier: {label, score, positive}`) so automations can
  react to a physical state (door open/closed) with **no LLM, no cloud, no
  extra latency**. We use it for an understairs-cupboard-door alert after
  demonstrating that small vision-language models answer this kind of subtle
  static question from prompt prior rather than perception.

## Install

1. Copy `nest_headless/` into `/addons/` on your HA host (or add this
   repository in the add-on store: ⋮ → Repositories).
2. Add-on store → ⋮ → Check for updates → install **Nest Headless Snapshot**
   (image build takes a few minutes) → Start.
3. Check the log for `receiver video codecs: ... video/H264 ...`.
4. Test: `curl "http://<ha-host>:8098/snapshot/<your_camera>?fresh=1" -o test.jpg`

See `nest_headless/DOCS.md` for all options and `examples/` for rest_command
and automation wiring.

## Quota

Every fresh capture opens and closes one WebRTC session = **one SDM command**
against Google's **100 commands/hour/camera** quota. `min_interval_seconds`
serves cached frames to close-together requests; keep periodic automations at
a sensible cadence.

## Verified

The capture path is exercised end-to-end in CI-able form: a mock HA websocket
speaking the real protocol (auth, `camera/webrtc/offer`, session/answer
events, simulated empty-foundation candidates) backed by a real pion sender,
against the production page functions (`test/loopback.js`). The one thing
that cannot be tested without a Google account and camera is Google itself —
that's what `probe/` is for.

## License

MIT
