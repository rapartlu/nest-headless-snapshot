# Nest Headless Snapshot — real stills from WebRTC-only Nest cameras

[![Open your Home Assistant instance and show the add add-on repository dialog with this repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Frapartlu%2Fnest-headless-snapshot)

## Is this your problem?

- Your Google Nest cameras **live-stream fine in the Home Assistant
  dashboard**, but…
- `camera.snapshot` (and camera-proxy images, notification thumbnails,
  `image_entity` in AI/LLM integrations) returns a **black image** — often
  the same tiny file every time.
- You tried restreaming through **go2rtc / Frigate / aiortc** and got a
  connection but **no video** — audio maybe, video never.

Then you have a **WebRTC-only Nest camera** (battery cams and most newer
models — no RTSP, no HLS via the SDM API). Home Assistant only relays WebRTC
signalling; it never decodes media, so anything that needs an actual frame
gets a placeholder.

**Why restreamers fail (the interesting part):** Google's media sender will
not send real video until the receiver returns **transport-wide congestion
control (TWCC) feedback**. Browsers implement TWCC, so Chrome gets video.
go2rtc and aiortc don't generate TWCC receiver feedback, so Google sends
them zero-byte bandwidth-probe padding forever — ICE and DTLS complete, the
session looks healthy, and no frame ever arrives. This repo includes a
[go probe](probe/) that demonstrates the mechanism in two minutes if you
want proof on your own camera.

**What this add-on does:** runs the client class that Google demonstrably
cooperates with — Chromium — headlessly on your HA machine. On request it
performs the browser WebRTC handshake against HA's own websocket API, waits
for the stream to ramp to 1080p (a few seconds), renders a frame, and gives
you a real JPEG — over HTTP and as a file your automations can use.

No credentials, no cloud, no extra Google setup: it authenticates only to
Home Assistant and uses your existing Nest integration. If a camera
live-streams in your dashboard, it works here.

## Install (standard add-on steps)

1. Click the blue button above — or go to **Settings → Add-ons → Add-on
   Store → ⋮ (top right) → Repositories** and add:
   `https://github.com/rapartlu/nest-headless-snapshot`
2. Find **Nest Headless Snapshot** in the store (refresh if needed) and
   click **Install**. The image builds on your machine — expect ~5 minutes.
3. Click **Start**, then check the **Log** for a line like
   `receiver video codecs: ... video/H264 ...`

> Requires a Supervisor-based install (Home Assistant OS or Supervised).
> amd64 and aarch64.

## Use it

There is **no camera configuration** — address any WebRTC camera by its
entity id (without the `camera.` prefix):

```bash
curl "http://homeassistant.local:8098/snapshot/front_door?fresh=1" -o still.jpg
```

If that returns a real photo, you're done. The frame is also written to
`/config/www/nest/front_door.jpg` for anything that reads files.

Typical automation wiring — a `rest_command` that returns only after a fresh
frame is on disk, so whatever follows always sees a current image:

```yaml
rest_command:
  capture_front_door:
    url: "http://homeassistant.local:8098/snapshot/front_door?fresh=1&format=json"
    method: get
    timeout: 45
```

```yaml
# in an automation
- action: rest_command.capture_front_door
  response_variable: capture
- condition: template   # never analyse a black frame
  value_template: "{{ (capture.content.meanLuma | default(255)) | float > 3 }}"
- action: llmvision.image_analyzer   # or notify with the image, etc.
  data:
    image_file: /config/www/nest/front_door.jpg
    ...
```

See [`examples/`](examples/) for complete, battle-tested patterns
(AI cat-on-the-worktop deterrent with rotating sounds, door-left-open alerts
with a tiny on-device classifier instead of an LLM) and
[`nest_headless/DOCS.md`](nest_headless/DOCS.md) for every option and
endpoint.

## Mind the quota

Every fresh capture is one WebRTC session = **one command** against Google's
SDM quota of **100 commands/hour/camera**. The `min_interval_seconds` option
(default 10 s) serves cached frames to rapid repeat requests, and concurrent
requests for the same camera coalesce into one capture. A 5-minute periodic
automation costs 12/hour — plenty of headroom; just don't poll in a tight
loop.

## Troubleshooting

- **Add-on log is empty** or the add-on can't reach HA on a *supervised*
  install: see "Broken supervised installs" in
  [`nest_headless/DOCS.md`](nest_headless/DOCS.md) — both have built-in
  workarounds.
- **`no answer from HA within timeout`**: check the camera live-streams in
  the HA dashboard first; this add-on can only capture what HA can stream.
- **Frames are 640×360**: the stream ramps to 1080p within a few seconds and
  the add-on waits up to 5 s for it; on very slow hardware raise
  `capture_timeout_seconds`.
- **Snapshot is dark/black with `meanLuma` < 3**: that's the guard working —
  the camera sent a black frame (privacy mode, off, or startup).

## What's in the repo

| Path | What |
|---|---|
| `nest_headless/` | The add-on (Node + headless Chromium, ~small) |
| `probe/` | Single-binary Go probe that proves the TWCC mechanism against your own camera |
| `tools/train_door_model.py` | Trainer for the optional tiny per-camera state classifiers |
| `examples/` | rest_command + automation patterns, VLM prompting lessons |

## License

MIT
