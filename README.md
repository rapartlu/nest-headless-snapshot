# Nest Headless Snapshot

Get real still images from your Google Nest cameras in Home Assistant, even
though Google only offers them over WebRTC.

[![Open your Home Assistant instance and show the add add-on repository dialog with this repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Frapartlu%2Fnest-headless-snapshot)

## Is this your problem?

- Your Nest cameras live-stream fine in the Home Assistant dashboard.
- But `camera.snapshot` gives you a black image. So do notification
  thumbnails and AI integrations that read the camera entity.
- The go2rtc, Frigate and aiortc workarounds never gave you a working
  snapshot either.

If that sounds familiar, you have a WebRTC-only Nest camera. That covers the
battery models and most newer ones. There is no RTSP or HLS for these.

## Why the snapshot is black

Home Assistant streams these cameras to your browser live, but it never grabs
a frame itself. For WebRTC-only Nest cameras, `camera.snapshot` just returns a
hardcoded placeholder image, which is the black frame you see. Home Assistant
relays the WebRTC handshake but does not terminate the media on the server, so
there is no frame for the snapshot to capture.

The frame is not impossible to capture. Server-side tools can pull one from
these cameras. Home Assistant simply does not wire snapshots through them for
these models yet, so anything that needs a still gets the placeholder. This
add-on fills that gap.

## What this add-on does

It runs a real browser (headless Chromium) on your Home Assistant machine.
When you ask for a snapshot, it opens the camera stream the same way your
dashboard does, waits a few seconds for full 1080p, grabs a frame, and gives
you a normal JPEG.

It only talks to Home Assistant. No Google credentials, no cloud, no extra
setup. If a camera streams in your dashboard, it will work here.

## Install

1. Click the blue button above. Or go to **Settings > Add-ons > Add-on
   Store**, open the menu in the top right, choose **Repositories**, and add
   `https://github.com/rapartlu/nest-headless-snapshot`
2. Find **Nest Headless Snapshot** in the store and click **Install**. The
   build takes around 5 minutes.
3. Click **Start**, then check the log for a line like
   `receiver video codecs: ... video/H264 ...`

The add-on route needs Home Assistant OS or a Supervised install. Running
Home Assistant Container or Core instead? See
[Plain Docker](#no-supervisor-plain-docker-works-too) below.

## Use it

No camera setup needed. Just use the camera's entity id without the
`camera.` prefix:

```bash
curl "http://homeassistant.local:8098/snapshot/front_door?fresh=1" -o still.jpg
```

If that gives you a real photo, you're done. The same frame is also saved to
`/config/www/nest/front_door.jpg` so automations can use it as a file.

Here is the usual wiring. The `rest_command` only returns once a fresh frame
is saved, so the next step always sees a current image:

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
- condition: template   # skip black frames
  value_template: "{{ (capture.content.meanLuma | default(255)) | float > 3 }}"
- action: llmvision.image_analyzer   # or a notification with the image, etc.
  data:
    image_file: /config/www/nest/front_door.jpg
    ...
```

The [examples folder](examples/) has complete real-world automations,
including an AI cat deterrent and a door-left-open alert. The
[add-on docs](nest_headless/DOCS.md) cover every option and endpoint.

## No Supervisor? Plain Docker works too

The add-on is really just a Docker container that talks to Home Assistant
with an access token, so Container and Core installs can run it directly:

1. Clone this repo on the machine that runs Docker.
2. In Home Assistant, create a long-lived access token (your profile >
   Security).
3. Edit [`docker-compose.yml`](docker-compose.yml): set your HA address and
   point the volume at your HA config's `www/nest` folder. Then:

   ```bash
   export HA_TOKEN='<your long-lived token>'
   docker compose up -d --build
   curl "http://localhost:8098/snapshot/<your_camera>?fresh=1" -o still.jpg
   ```

Every add-on option is available as an environment variable. The compose
file lists them all. Everything else in this README works the same way.

## Mind the quota

Each fresh capture counts as one command against Google's limit of 100
commands per hour per camera. Repeat requests within 10 seconds (adjustable)
get the cached frame instead, and simultaneous requests for the same camera
share one capture. A check every 5 minutes uses 12 per hour, which leaves
plenty of headroom. Just don't poll in a tight loop.

## Troubleshooting

- **Empty add-on log, or the add-on can't reach HA** on a Supervised
  install: see "Broken supervised installs" in the
  [add-on docs](nest_headless/DOCS.md). Both problems have built-in
  workarounds.
- **"no answer from HA within timeout"**: check the camera streams in your
  dashboard first. The add-on can only capture what HA can stream.
- **Frames come back 640x360**: the stream takes a few seconds to reach
  1080p and the add-on waits up to 5 seconds for it. On slow hardware, raise
  `capture_timeout_seconds`.
- **Snapshot is black and `meanLuma` is under 3**: the camera really sent a
  black frame (privacy mode, switched off, or still starting up). That's
  what the guard in the automation example is for.

## What's in the repo

| Path | What |
|---|---|
| `nest_headless/` | The add-on (Node plus headless Chromium) |
| `tools/train_door_model.py` | Trainer for the optional per-camera state classifiers |
| `examples/` | Ready-to-adapt automations and hard-won prompting advice |

## License

MIT
