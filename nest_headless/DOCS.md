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
| `HA_CONFIG_DIR` | the mounted HA config dir, e.g. `/Volumes/docker/homeassistant/homeassistant` |
| `OPTIONS_FILE` | a JSON copy of the add-on options (same keys as `config.yaml`) |
| `HA_WS_URL` | `ws://<ha-host>:8123/api/websocket` |
| `TOKEN_FILE` | local file holding a long-lived HA token (mode 600) |
| `LOG_FILE` | local log path (keeps `sh` off the share) |

Start with `sh nest_headless/run.sh`. Samples, `latest`, the timeline and
models still live on the HA config share, so dashboards keep working.

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
    <key>HA_CONFIG_DIR</key><string>/Volumes/docker/homeassistant/homeassistant</string>
    <key>OPTIONS_FILE</key><string>/Users/you/.config/nest_headless/options.json</string>
    <key>HA_WS_URL</key><string>ws://192.168.0.69:8123/api/websocket</string>
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
