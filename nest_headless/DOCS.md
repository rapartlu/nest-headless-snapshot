# Nest Headless Snapshot

Gets real still images from WebRTC-only Google Nest cameras by running a
headless browser on your Home Assistant machine. The repository README has
the full story.

## Watch mode (persistent streams)

By default every snapshot dials a fresh WebRTC session: one Google API
command and 8-12 seconds each time. Watch mode instead holds one stream open
per camera and samples it locally.

Only watch cameras that are on mains power. A held stream is the most
battery-hungry thing you can ask of a battery camera.

Options:

| Option | Example | What it does |
|---|---|---|
| `watch_cameras` | `kitchen_camera:4` | keep a stream open, sample every 4 s (space-separate multiple cameras) |
| `watch_rois` | `kitchen_camera:table@0.26:0.55:0.62:0.43;island@0.30:0.32:0.22:0.12` | regions to diff for surface activity (fractions of the frame, `name@x:y:w:h`) |
| `watch_diff_pct` | `4` | percent of a region's pixels that must change to count as a hit |
| `watch_cooldown_seconds` | `60` | minimum gap between fired events per camera |
| `watch_classify_seconds` | `15` | score the live stream with the camera's trained model every N seconds (0 disables) |
| `watch_classify_persist_ticks` | `16` | classifier ticks that must agree before `nest_headless_classifier_positive` fires |
| `sample_archive_seconds` | `120` | heartbeat archive cadence per camera (frames + `timeline.json` under `samples_dir`) |
| `audio_cameras` | (empty) | cameras whose microphone is tapped for the wake word (space-separated) |
| `speech_silence_ms` | `800` | quiet after speech that closes a capture (judged relative to the speech level) |
| `speech_max_seconds` | `15` | hard stop for a capture |
| `stt_model_dir` | (empty) | in-process recogniser: a sherpa-onnx transducer or Whisper directory; empty = the spotter's own transducer |
| `stt_url` | (empty) | external recogniser (`host/whisper_server.py` or whisper.cpp `whisper-server`), used ahead of the in-process one |
| `stt_shadow_url` | (empty) | second recogniser for bake-offs; its text is only logged |
| `stt_fallback_url` | (empty) | second server tried when `stt_url` fails, before the in-process recogniser (keep a different engine warm as the backup) |
| `identity_keep_samples` | `false` | keep raw enrolment audio / aligned face crops on disk |
| `identity_auto_samples` | `true` | keep an embedding-only room sample from each confident room voice match (12 per person, oldest auto sample out; consented samples never displaced) |
| `wake_by_transcript` | `false` | transcribe every speech segment on the tapped mics (in memory) and treat a wake phrase at its head as the wake word; enables conversation windows |
| `watch_passages` | (empty) | doorway polygons with an optional `in=x,y` room-side point → `nest_headless_passage` |
| `watch_classify_zones` | (empty) | state zones (change detection with crops; optional `<camera>__<zone>.onnx`) |
| `watch_activity_zones` | (empty) | running/idle from motion inside a crop → `nest_headless_activity` |
| `activity_pct` | `1.5` | per-tick change (%) inside an activity zone that counts as motion |
| `zone_change_threshold` | `10` | mean grey difference (0-255) on a state zone's fingerprint that counts as a change |

What you get:

- `/snapshot/<camera>` answers from the live stream in well under a second
  (`frames: -1` in the JSON meta marks a live-stream frame).
- A hit in any region fires the `nest_headless_surface_activity` event
  ({camera, roi, changed_pct}) - trigger an automation on it to react within
  seconds (confirm with a vision model before acting; a person leaning over
  the worktop trips the same wire).
- Cameras with a crop and a trained model also fire
  `nest_headless_classifier_positive` ({camera, label, score}) when the model
  says so - the framing check is applied first so a moved camera stays quiet.
- A camera without regions is still worth watching: you get the instant
  snapshots and classifier ticks with no event noise.

The stream reconnects automatically if it drops. Watch health is visible in
the `/` status JSON under `watches`.

## Local vision models

Two kinds of model run in-process (native onnxruntime, no cloud, no quota):

1. **Cat/object detector** - export the pretrained COCO weights yourself
   (they are AGPL-licensed, so not bundled here):

       pip install ultralytics
       yolo export model=yolo11n.pt format=onnx imgsz=640
       cp yolo11n.onnx nest_headless/app/assets/models/

   With the file in place, surface-motion hits and `GET /detect/<camera>`
   run detection over each watched region and report `cat_on_surface`.

   **If the pretrained detector misses your animal, fine-tune it.** COCO
   weights have a real blind spot for climbing, motion-blurred, partly
   occluded pets at night - a plainly visible worktop raid can score under
   0.10. A single-class model trained on a few dozen frames from your own
   camera fixes this decisively (~0.93 on the same frame). Collect hit
   frames from `samples/`, draw boxes (any YOLO-format labeller), then:

       yolo detect train model=yolo11n.pt data=<dataset.yaml> epochs=60 imgsz=960
       yolo export model=runs/detect/train/weights/best.pt format=onnx imgsz=960
       cp best.onnx nest_headless/app/assets/models/cats.onnx

   When `cats.onnx` exists it is preferred over the COCO model for all cat
   checks; detections still report class `cat`. Include negatives (people
   cooking, empty room, lamp reflections) as background images so the model
   learns what NOT to fire on.

2. **Per-camera state classifiers** - fine-tune a small classifier on your
   own crops (two folders of labelled images):

       yolo classify train model=yolo11n-cls.pt data=<dataset> epochs=40 imgsz=256
       yolo export model=runs/classify/train/weights/best.pt format=onnx imgsz=256
       cp best.onnx <config>/nest_models/<camera>.onnx

   The `.onnx` outranks the linear `.json` verdict when both exist; the
   linear model still provides the framing tripwire. Retraining is just
   replacing the file - it hot-loads on change.

## Passage zones (doorways)

`watch_passages` draws polygons across doorways, per camera, with the same
polygon syntax as `watch_rois` plus an optional inside point after `|`:

```
watch_passages: "hall_camera:bathroom@0.62,0.55:0.70,0.55:0.72,0.72:0.60,0.72|in=0.66,0.40;front_door@...;  landing_camera:bedroom@...|in=..."
```

`in=x,y` is any point on the room side of the door (it may lie outside the
frame); it decides `in` versus `out`. Without it the direction is `across`.
Draw the polygon on the floor across the threshold: the test uses the
person's feet (box bottom-centre). When someone walks into the doorway and
disappears (the room is out of view) that counts as going `in`; someone who
appears in the doorway and walks away counts as coming `out`; stepping into
the doorway and turning back posts nothing. Event: `nest_headless_passage`
{camera, passage, direction, track_id, t, person {matches, name, score,
size_px}, faces [{box, size_px, det_score, matches, name, score}], attributes
{height_ratio, carrying}}. `faces` lists every face in the frame, matched or
not, so a small unidentified face still says "someone was there". A
passage can also name a camera to look from after a crossing, `look:
{camera, delay_ms, until_ms?, every_ms?, min_face_px?}` (zones.json / `PUT
/zones`), for a doorway where the face is small from the hall but large
from the room's own camera a few seconds later: frames are taken from that
camera's held stream between `delay_ms` and `until_ms` (every `every_ms`,
stopping at the first face of `min_face_px` or more) and one
`nest_headless_passage_look` follows with the same `track_id`, the best
`person`, `faces`, `attempts`, `at_ms` and a `reason` (`face_too_small`,
`no_face`) when nobody could be identified. A zone editor draws these
the same way it draws surface zones.

## Camera framing tripwire

If a classifier model has reference features, each capture also reports
`classifier.refCorr` (how well the frame registers against the model's
reference scene, measured on the right side of the crop) and
`classifier.framingOk` (true when refCorr >= 0.45). If the camera view ever
changes - a knock, a zoom setting, or the vendor silently changing the
stream crop - framingOk goes false. Have your automations trust `positive`
only when `framingOk` is true, and notify instead: verdicts from a shifted
view are meaningless, and the model needs a quick retrain on the new view.

## Quick start

1. Start the add-on and check the log for
   `receiver video codecs: ... video/H264 ...`
2. Test it with any camera that live-streams in your dashboard. Use the
   entity id without the `camera.` prefix:
   `curl "http://homeassistant.local:8098/snapshot/<your_camera>?fresh=1" -o still.jpg`
3. Wire it into automations with a `rest_command`. See the repository's
   `examples` folder. Each fresh capture uses one Google SDM command
   (the quota is 100 per hour per camera).

No per-camera configuration is needed. The defaults below are sensible.

## Options

| Option | Default | What it does |
|---|---|---|
| `min_interval_seconds` | `10` | Requests within this window get the cached frame instead of a new capture. Add `?fresh=1` to force a capture. |
| `jpeg_quality` | `85` | JPEG quality, 30 to 100. |
| `capture_timeout_seconds` | `25` | How long one capture may take before giving up. |
| `warmup_frames` | `3` | Frames to skip before taking the picture. The add-on also waits up to 5 seconds for the stream to reach 1080p, since Nest streams start at 640x360. |
| `out_dir` | `/config/www/nest` | Where JPEGs are saved. |
| `crops` | (empty) | Fixed regions of interest, written as an extra `<camera>_crop.jpg` next to each frame. Format: `camera_name:x:y:w:h` with values as fractions of the frame, for example `hallway_cam:0.35:0.0:0.28:0.55`. Separate multiple cameras with spaces. |
| `samples_dir` | (empty) | If set (for example `/homeassistant/www/nest/samples`), every capture's crop is also saved with a timestamp, up to 2000 per camera. Useful as training data for the classifiers below. |

## HTTP API (port 8098)

```
GET /snapshot/<camera>                 capture now, or cached if recent
GET /snapshot/<camera>?fresh=1         always capture (one SDM command)
GET /snapshot/<camera>?fresh=1&format=json   capture, return details as JSON
GET /latest/<camera>.jpg               last saved frame, 404 if none yet
GET /                                  status JSON
GET /health                            liveness check
```

`<camera>` is the entity id without the `camera.` prefix. The JSON includes
`meanLuma`, a brightness number you can use to skip black frames (a black
placeholder measures about 6, real frames measure far higher, so checking
`meanLuma > 3` is a good guard). If you have trained a classifier for the
camera, the JSON also includes its verdict as
`classifier: {label, score, positive}`.

## Per-camera classifiers (optional)

For simple fixed-scene questions like "is that cupboard door open", a tiny
local model beats asking an AI service every time. It runs on every capture
in well under a millisecond, costs nothing, and can't be talked out of what
it sees.

Put a trained weights file at `/config/nest_models/<camera>.json` and the
add-on picks it up automatically, no restart needed. Train one with
`tools/train_door_model.py` from the repository:

1. Set the `crops` option to frame the thing you care about, and set
   `samples_dir` so captures build up a library of crops.
2. Sort some crops into two folders, one per state.
3. Run the script and copy the JSON it produces to `/config/nest_models/`.

Tips from real use:

- Start with a handful of images per state. When the model gets one wrong,
  add that image to the right folder and retrain. It takes about two
  minutes.
- Collect samples across the day and night before trusting it after dark.
- Watch out for lookalikes. Another door or object entering the crop can
  imitate the thing you're detecting. Add those frames as examples of the
  "no" state and retrain.
- If a false alarm is worse than a missed one, set `threshold` in the JSON
  to 0.9, and have the automation confirm with a second capture 30 to 60
  seconds later before acting.

## Broken supervised installs

Some Supervised installs have an unhealthy Supervisor. Two workarounds are
built in:

- **The add-on starts then dies, and its log shows no SUPERVISOR_TOKEN.**
  Create a long-lived access token in HA and save it to a file named
  `.nest_headless_token` in your config folder. The add-on will use it to
  talk to HA directly.
- **The Log tab is always empty.** Create an empty file named
  `nest_headless_log_to_file` in your config folder, and the add-on will
  write its log to `nest_headless_boot.log` there instead.

## Running on a Mac (outside the Supervisor)

The app is plain Node + Chromium; nothing in it needs the Supervisor. On a
Mac on the same LAN it gets ~20x the CPU of a small NAS (cat detection
~160 ms instead of 3-5 s) and the browser's WebRTC audio never starves.

Requirements: Node 20, Google Chrome, `jq`, the HA config directory mounted
(SMB share), and a long-lived HA token.

```sh
cd nest_headless/app && npm install
# copy the ONNX models you built into app/assets/models/ (see Local vision models)
```

Environment (a launchd plist is the natural home; see the example below):

| variable | value |
|---|---|
| `HA_CONFIG_DIR` | the mounted HA config dir, e.g. `/Volumes/<share>/homeassistant` |
| `OPTIONS_FILE` | a JSON copy of the add-on options (same keys as `config.yaml`) |
| `HA_WS_URL` | `ws://<ha-host>:8123/api/websocket` |
| `TOKEN_FILE` | local file holding a long-lived HA token (mode 600) |
| `LOG_FILE` | local log path (keeps `sh` off the share) |
| `UV_THREADPOOL_SIZE` | `8`: headroom for the async disk I/O against the share (Node's default pool is 4) |

Start with `sh nest_headless/run.sh`. Samples, `latest`, the timeline and
models still live on the HA config share, so dashboards keep working. Run
`npm install` in the checkout the service actually starts from: `sharp` is
a native dependency and, when it is missing, JPEG decoding silently falls
back to JS on the main thread (the log says `sharp unavailable`).

Disk I/O against the share is slow (a 250 KB write 70-180 ms, a `readdir`
of a 2000-file archive 2.6 s) and since 1.12.3 none of it touches the event
loop: writes are queued per file or directory and listings are cached. If
`loop_lag_ms` on `GET /` climbs anyway, look for a new synchronous call
before blaming the models.

macOS privacy: a launchd agent is refused access to network volumes
("Operation not permitted") until the `node` binary is granted **Full Disk
Access** (System Settings -> Privacy & Security). `run.sh` only touches the
share through `node`, so that one grant is enough. Keep the Mac from sleeping
(`pmset -c disablesleep 1` on power) or the cameras go unwatched while the lid
is closed; keep the Supervisor add-on installed with `boot: manual` as a cold
standby.

Example `~/Library/LaunchAgents/com.example.nest-headless.plist`:

```xml
<plist version="1.0"><dict>
  <key>Label</key><string>com.example.nest-headless</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>/path/to/nest_headless/run.sh</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/path/to/node/bin:/usr/bin:/bin</string>
    <key>HA_CONFIG_DIR</key><string>/Volumes/<share>/homeassistant</string>
    <key>OPTIONS_FILE</key><string>/Users/you/.config/nest_headless/options.json</string>
    <key>HA_WS_URL</key><string>ws://homeassistant.local:8123/api/websocket</string>
    <key>TOKEN_FILE</key><string>/Users/you/.config/nest_headless/token</string>
    <key>LOG_FILE</key><string>/Users/you/Library/Logs/nest_headless.log</string>
  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
</dict></plist>
```

`ProcessType: Interactive` matters: without it macOS App Nap throttles the
windowless Chrome and the audio tap delivers ~40% of real time (measured
1.7 chunks/s instead of 4), which silently breaks keyword spotting and
starves speech captures. Load with `launchctl bootstrap gui/$(id -u) <plist>`; the service answers on
`http://127.0.0.1:8098/` and the consumers (Hearth) should use that address.

### Whisper large-v3-turbo on the Mac (MLX)

The in-process recogniser (`stt_model_dir`, sherpa-onnx Whisper small.en) is
the fallback. For the real thing on Apple silicon run `host/whisper_server.py`
(Apple MLX, GPU) and point `stt_url` at it; it speaks the same `POST
/inference` multipart shape as whisper.cpp's `whisper-server`, so either
works. large-v3-turbo transcribes a 5 s utterance in ~0.5-0.7 s on an M3 Pro.

```sh
python3 -m venv ~/.config/nest_headless/venv
~/.config/nest_headless/venv/bin/pip install mlx-whisper
WHISPER_MODEL=mlx-community/whisper-large-v3-turbo PORT=8178 \
  ~/.config/nest_headless/venv/bin/python host/whisper_server.py   # first start fetches ~1.5 GB
```

Then `"stt_url": "http://127.0.0.1:8178"` in the options file and restart the
add-on. Run it under launchd like the add-on (KeepAlive, ProcessType
Interactive). Audio goes over loopback only and is never written to disk;
the add-on falls back to the in-process model whenever the server is down.

**Serving the LAN (HA Assist, phones):** `BIND=0.0.0.0` and either
`WHISPER_TOKEN=<secret>` or `WHISPER_TOKEN_FILE=<path>` (mode 600). With a
token set, `POST /inference` from anywhere except loopback requires
`Authorization: Bearer <token>`; `/health` stays open; the add-on on the same
host keeps using loopback without one. Keep the token out of the plist by
using `WHISPER_TOKEN_FILE`.

### House Voice: Kokoro text-to-speech on the Mac (MLX)

`host/tts_server.py` runs Kokoro-82M (British voices) on Apple MLX next to
the Whisper server: `GET /health`, `GET /voices`, `POST /speak` with JSON
`{"text", "voice", "speed"}` returning 24 kHz mono 16-bit WAV. A 15-word
reply synthesises in ~0.2 s on an M3 Pro. Same LAN posture as the Whisper
server: `BIND`, `TTS_TOKEN` / `TTS_TOKEN_FILE` (bearer token required for
`/speak` off-loopback), default port 8179, voices via `TTS_VOICES`, default
voice `TTS_VOICE`.

```sh
~/.config/nest_headless/venv/bin/pip install mlx-audio "misaki[en]"
TTS_VOICE=bf_emma PORT=8179 ~/.config/nest_headless/venv/bin/python host/tts_server.py
```

Note for both host servers: launchd reads `EnvironmentVariables` only at
`bootstrap`; after editing the plist do `launchctl bootout` then `bootstrap`
(a `kickstart -k` restarts the process with the old environment).

## Identity: who is talking, who is in view

Voice: every `nest_headless_speech` is followed by `nest_headless_identity`
{utterance_id, speaker: {quality: {speech_ms, rms, reason}, matches: [{name,
score, room, upload}]}, faces: [...]}. Speaker embeddings come from
`nest_models/identity/models/speaker.onnx` (3D-Speaker ERes2Net); same
person on these mics scores ~0.6+, strangers ~0.4-. `score` is the best over
all of a person's samples; `room` and `upload` are the bests over samples
from a camera microphone and from phone uploads (null when there are none).
A voice enrolled only from a phone at arm's length scores lower on a ceiling
microphone (level, reverb, bandwidth), and the split shows that rather than
leaving the brain to guess: label a couple of room captures from the backlog
and `room` catches up.

Faces: `nest_models/identity/models/{scrfd_10g.onnx, arcface_w600k_r50.onnx}`
(InsightFace buffalo_l). Faces are sampled at the wake moment and 1 s later;
each is `{name|null, score, box, quality: {size_px, det_score, reason},
matches}`. `name` is set at cosine >= 0.4. Faces under 60 px are detected
but not identified: with a camera high on a wall a face at the far end of the room is
~30 px; at a table below the camera 60-120 px.

Endpoints (loopback, or `Authorization: Bearer <API_TOKEN>` from the LAN):

- `GET /identity` -> people with voice/face sample counts, `face_models`.
- `POST /identity/voice/enrol` {camera, name, utterance_id?} -> enrols the
  latest (or given) utterance; refusals carry `speech_ms`, `rms`,
  `needed_speech_ms`.
- `POST /identity/face/enrol` {camera, name, index?} or {name, image_b64,
  index?} -> enrols the face in view / in the image; refusals `no_face`,
  `face_too_small` (`size_px`, `needed_px`), `multiple_faces` (candidates
  with `index`), `bad_image`.
- `GET /identity/who/<camera>` -> faces in one fresh frame.
- `POST /identity/voice/who` {audio_b64, format?} -> {quality: {speech_ms,
  rms, reason}, matches: [{name, score, room, upload}], decisive}: who is
  speaking in an uploaded clip (>= 1 s voiced, up to 15 s); WAV, or m4a/caf
  where the host has `afconvert`/`ffmpeg`. Nothing is kept.
- `DELETE /identity/<name>` -> forgets voice and face.

Embeddings are JSON under `nest_models/identity/<name>/`; raw audio or the
aligned 112x112 face crop are kept only with `identity_keep_samples`. The
add-on never decides who someone is or enrols on its own.

### Verification backlog and onboarding

Samples the add-on could enrol but cannot attribute confidently are parked
for an admin (never under `www/`): `GET /identity/pending` lists them with a
`media_url` (clip or crop), `POST /identity/pending/<id>/label {name}`
enrols one, `POST /identity/pending/<id>/unknown` marks a visitor (kept as a
negative for 30 days so they are not queued again), `DELETE` drops one.
`POST /identity/pending/<id>/not_person` marks a false face (a poster, a
reflection, the cat) or a non-speech clip (the TV, a dog): the sample moves
to `nest_models/identity/negatives/not_person/` as a hard negative, later
candidates that resemble it are dropped before the backlog and never matched
to a person, and `GET /identity/negatives` / `DELETE /identity/negatives/<id>`
manage the set (kept until deleted, cap 500).
`nest_headless_identity_pending` {count, newest?} keeps a badge honest.
Retention: 7 days or 200 samples. Onboarding from a phone: voice enrol with
`{name, audio_b64, phrase?}` (16-bit WAV, 3-10 s) several times per person;
face enrol with `pose`; `GET /identity/<name>` shows what is held, including
`voice_sources` / `face_sources` {room, upload} so an admin can see when a
person has no room-channel samples yet. Every sample file carries `source`
(`room` or `upload`); backlog labels are always `room`. With
`identity_auto_samples` (default on) a confident room voice match also keeps
its embedding as a room sample flagged `auto`, so the room channel fills in
on its own after the first couple of labels.

## Follow-up window and the API token

### Transcript wake path and conversation windows

With `wake_by_transcript` on, the add-on does not rely on the small spotter
alone. Each speech segment on a tapped microphone (onset above the noise
floor, 0.5 s pre-roll, closed by 3 chunks of relative quiet, 15 s cap) is
sent to the recogniser, and the transcript decides: a wake phrase at the
head is a keyword hit (`nest_headless_keyword` with `source: transcript`)
followed by the usual speech and identity events; a segment inside an open
conversation window is the reply; anything else is discarded without being
kept, logged or sent. The spotter keeps running and the two paths never
report the same utterance twice (`wake_source` on the speech event says
which caught it). Cost: one recogniser call per spoken sentence in range of
the microphones, ~0.2 s each on the Mac. Why: the 3 MB spotter decoded a
loud, close "Hey Claude" as "I glob" and no threshold could match it, while
the recogniser transcribed it perfectly.

`POST /listen/<camera>?mode=conversation&seconds=10&reason=...` opens a
window (up to 60 s) in which the next speech segment is the reply, so the
person can pause, cough and start again with no wake phrase. One reply
closes it; `DELETE /listen/<camera>` closes it early, which the brain should
do before it plays a reply on the speaker, or the house will hear itself.
`GET /` lists open windows under `conversations`.

Latency notes: the speculative transcription begins at 250 ms of closing
quiet and its text is published as `nest_headless_speech_partial` (`final:
false`, same `utterance_id` as the final event) for captures the house was
addressed on, so a brain can begin its turn early and confirm against the
final; a transcript ending in a question mark closes the capture at 400 ms
of quiet. A sentence two microphones hear is transcribed once (the second
camera's copy is dropped; `concurrent_cameras` still names it).

`POST /listen/<camera>?seconds=8&reason=after_tts` opens a speech capture
without a wake word (for the brain, right after it has spoken): same
end-pointing, same `nest_headless_speech` with `keyword: "follow-up"`,
`opened_by` (caller address) and `open_reason`; no event at all if nobody
says anything intelligible. 409 while a capture is open, 404 without an
audio tap. Every call is logged with the caller.

`/listen`, `/identity`, `/utterance` and `/audiodebug` are loopback-only
unless the caller sends `Authorization: Bearer <token>` (`API_TOKEN` or
`API_TOKEN_FILE`). Snapshot, frame, detect and status stay LAN-open for Home
Assistant. Denials are logged with the address.

## Recogniser bake-offs

Two servers can stay warm with one primary: point `stt_url` at the engine
you trust and `stt_fallback_url` at the other; `host/stt_switch.sh
parakeet|whisper` swaps them and restarts the service. The authors ended a
day-long shadow run with Parakeet primary: equal on commands, better on
names, and silent on near-silence where Whisper produced text.

`stt_shadow_url` sends every utterance to a second recogniser in parallel
and logs its text as `SHADOW` lines next to the `SPEECH` line, without using
or posting it. `host/whisper_server.py` serves either `STT_ENGINE=mlx-whisper`
(default, whisper-large-v3-turbo) or `STT_ENGINE=parakeet-mlx`
(Parakeet-TDT 0.6B v3), always from worker processes (`WHISPER_WORKERS`).


## Evidence by reference

A brain that explains a decision needs the frame it came from. Every frame
the add-on judges goes into a per-camera memory ring, frames behind events
are kept in the archive under `<camera>_events/`, and:

- `GET /archive/<camera>/<time>.jpg[?within=ms]` returns the nearest frame
  to `time` (ISO 8601, a `2026-09-03T16-24-52-317Z` stamp, or epoch ms) from
  memory, the event archive or the heartbeat archive; `X-Frame-At`,
  `X-Frame-Source` (memory | events | archive) and `X-Frame-Distance-Ms`
  say what you got; 404 beyond `within` (default 120 s).
- Events carry `frame_at` and `boxes: [{label, x, y, w, h, score?, name?}]`
  in frame fractions - the passage zone, the tracked person and faces on a
  passage; the zone and people nearby on zone events; the surface and the
  detections on surface activity; the faces on speech and identity - so a
  viewer can draw the frame as the add-on saw it.
- Zone changes keep a before|after composite; the event names it as
  `look_url` and `GET /look/zones/<camera>/<zone>/<time>.jpg` serves the
  nearest one.
- `/utterance/<id>.wav` stays available for 24 h for speech addressed to the
  house (memory only, cap 300, gone on restart); other captures 90 s.

## Zones API (the app's zone editor)

- `GET /zones` -> `{version, frame: {w, h}, cameras: {<camera>: {surfaces,
  passages, state, activity}}, watched, file}`. Each zone is `{name, pts:
  [[x,y],...]}` or `{name, x, y, w, h}` in frame fractions; passages add
  `inside: [x,y] | null`.
- `PUT /zones` with `{cameras: {<camera>: {surfaces?, passages?, state?,
  activity?}}}` replaces the kinds you send for the cameras you send (send an
  empty array to clear a kind). Validation errors come back as 400 with a
  reason; nothing is applied unless everything validates. On success the
  change is saved to `<config>/nest_models/zones.json` and applied live.
  Needs loopback or `Authorization: Bearer <API_TOKEN>`.
- Draw on `/frame/<camera>` (open, LAN): fractions of that frame.

Kinds: `surfaces` (cat zones), `passages` (doorways, direction from
`inside`), `state` (change detection with before/after crops; optional model
`<camera>__<name>.onnx`), `activity` (running/idle from in-zone motion).
