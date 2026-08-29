# Nest Headless Snapshot

Gets real still images from WebRTC-only Google Nest cameras by running a
headless browser on your Home Assistant machine. The repository README has
the full story.

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
