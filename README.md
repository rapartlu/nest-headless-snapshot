# Nest Headless Snapshot

Real stills, live watching, and local perception for WebRTC-only Google Nest
cameras in Home Assistant — with no Google credentials and nothing leaving the
house.

[![Open your Home Assistant instance and show the add add-on repository dialog with this repository URL pre-filled.](https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg)](https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2Frapartlu%2Fnest-headless-snapshot)

## Is this your problem?

- Your Nest cameras live-stream fine in the Home Assistant dashboard.
- But `camera.snapshot` gives you a black image. So do notification
  thumbnails and AI integrations that read the camera entity.
- The go2rtc, Frigate and aiortc workarounds never gave you a working
  snapshot either.

If that sounds familiar, you have a WebRTC-only Nest camera (the battery
models and most newer ones). There is no RTSP or HLS for these. Home Assistant
relays the WebRTC handshake but never terminates the media, so anything that
needs a still gets a placeholder.

## What it does

It runs a real browser (headless Chromium) that opens the camera stream the
same way your dashboard does, and works on the frames and the microphone
audio locally:

- **Stills** on demand: `GET /snapshot/<camera>` (archived) and
  `GET /frame/<camera>` (instant, no side effects), plus `/latest/<camera>.jpg`.
- **Watch mode**: persistent streams, motion in named zones, an archive with a
  timeline, and a stream of Home Assistant events the rest of your automation
  can react to.
- **Perception primitives**, all local ONNX / sherpa / MLX models:
  - cat-on-surface zones (a house-trained detector plus COCO veto) →
    `nest_headless_surface_activity`
  - per-camera door-state classifiers → `nest_headless_classifier_positive`
  - **passages**: a person crossing a doorway, with direction and a track id →
    `nest_headless_passage`
  - **state zones**: "this zone's look changed", with before/after crops and
    who was nearby → `nest_headless_zone_change` (an optional trained model
    adds `nest_headless_zone_state`)
  - **activity zones**: running/idle from motion inside a crop (a drum behind
    glass) → `nest_headless_activity`
  - **wake word + speech**: a keyword spotter on the camera microphone, a
    speech capture with careful end-pointing, and a transcript from Whisper
    (or Parakeet) → `nest_headless_keyword`, `nest_headless_speech`; a
    follow-up window for conversations (`POST /listen`)
  - **identity**: speaker embeddings and face embeddings, matched against
    people enrolled by consent → `nest_headless_identity`
- **Zone editor API** (`GET/PUT /zones`): every zone kind, polygons or
  rects, hot-applied without a restart, persisted in `zones.json`.

The design line is deliberate: this add-on is the *senses*. It notices that
something happened and hands over crops, transcripts, embeddings and events.
Deciding what it means — answering a question, keeping a household ledger,
choosing who to tell — belongs to a separate brain that consumes the events
(the authors run one; any automation or agent works).

## Privacy stance

- Audio is processed in memory. Utterance audio is held for 90 s so a brain
  can fetch it, then gone. Nothing is kept on disk except: enrolment samples
  if you enable `identity_keep_samples`, and — if you use the verification
  backlog — short clips and face crops the add-on could not attribute, kept
  for at most 7 days for an admin to label or drop.
- Identity is opt-in per person through the enrolment endpoints; the add-on
  never decides who someone is or enrols on its own — it reports scores and
  parks ambiguous samples for a human.
- Everything runs on your hardware. No cloud, no Google credentials: it only
  talks to your Home Assistant.
- The routes that open a microphone window, touch identity or serve raw audio
  are loopback-only unless the caller presents a bearer token.

## Install

1. Click the blue button above, or add
   `https://github.com/rapartlu/nest-headless-snapshot` under **Settings >
   Add-ons > Add-on Store > Repositories**.
2. Install **Nest Headless Snapshot** (the build takes a few minutes) and
   start it. The log should show a line like
   `receiver video codecs: ... video/H264 ...`.

The add-on route needs Home Assistant OS or a Supervised install. Container
and Core installs can run it with [plain Docker](#no-supervisor-plain-docker-works-too),
and it also runs directly on a Mac — see [Running on a Mac](nest_headless/DOCS.md#running-on-a-mac-outside-the-supervisor)
in the docs, which is the setup to use if you want the heavier models
(Whisper, faces) at low latency.

## Use it

Stills need no setup; use the camera's entity id without the `camera.` prefix:

```bash
curl "http://homeassistant.local:8098/snapshot/front_door?fresh=1" -o still.jpg
```

The same frame is saved to `/config/www/nest/front_door.jpg` so automations
can use it as a file. The usual wiring, which only returns once a fresh frame
is saved:

```yaml
rest_command:
  capture_front_door:
    url: "http://homeassistant.local:8098/snapshot/front_door?fresh=1&format=json"
    method: get
    timeout: 45
```

```yaml
- action: rest_command.capture_front_door
  response_variable: capture
- condition: template   # skip black frames
  value_template: "{{ (capture.content.meanLuma | default(255)) | float > 3 }}"
- action: llmvision.image_analyzer
  data:
    image_file: /config/www/nest/front_door.jpg
```

Watch mode, zones, speech and identity are configured through the add-on
options (or a `zones.json` written by the zones API). The
[add-on docs](nest_headless/DOCS.md) cover every option, endpoint and event;
the [examples](examples/) folder has complete automations.

## No Supervisor? Plain Docker works too

The add-on is a Docker container that talks to Home Assistant with an access
token:

1. Clone this repo on the machine that runs Docker.
2. In Home Assistant, create a long-lived access token (profile > Security).
3. Edit [`docker-compose.yml`](docker-compose.yml): set your HA address and
   point the volume at your HA config's `www/nest` folder. Then:

   ```bash
   export HA_TOKEN='<your long-lived token>'
   docker compose up -d --build
   curl "http://localhost:8098/snapshot/<your_camera>?fresh=1" -o still.jpg
   ```

Every add-on option is available as an environment variable.

## Mind the quota

Each fresh capture counts as one command against Google's limit of 100
commands per hour per camera. Repeat requests within 10 seconds get the cached
frame, and simultaneous requests share one capture. Watch mode holds one
stream per camera instead of polling, which is far cheaper on the quota.

## Troubleshooting

- **Empty add-on log, or the add-on can't reach HA** on a Supervised install:
  see "Broken supervised installs" in the [docs](nest_headless/DOCS.md).
- **"no answer from HA within timeout"**: check the camera streams in your
  dashboard first. The add-on can only capture what HA can stream.
- **Frames come back 640x360**: the stream takes a few seconds to reach 1080p.
  On slow hardware, raise `capture_timeout_seconds`.
- **Snapshot is black and `meanLuma` is under 3**: the camera really sent a
  black frame (privacy mode, switched off, or still starting up).
- **Audio arrives gapped, wake words stop firing**: the host is starving the
  browser. On a small NAS the add-on lowers its own priority behind Chromium;
  on a Mac, run it under launchd with `ProcessType: Interactive` (App Nap
  otherwise throttles a windowless Chrome). Details in the docs.

## What's in the repo

| Path | What |
|---|---|
| `nest_headless/` | The add-on (Node plus headless Chromium): `app/` code, `host/` servers for running the speech models on a Mac |
| `nest_headless/DOCS.md` | Options, endpoints, events, zones, identity, Mac mode |
| `nest_headless/CHANGELOG.md` | Every release, with the reasoning behind each change |
| `tools/train_door_model.py` | Trainer for the optional per-camera state classifiers |
| `examples/` | Ready-to-adapt automations and a timeline dashboard card |

## License

MIT
