# Nest Headless Snapshot

Captures real still images from WebRTC-only Google Nest cameras by running
the exact client Google's sender cooperates with — Chromium — headlessly on
your Home Assistant host. See the repository README for the full background.

## Options

| Option | Default | Meaning |
|---|---|---|
| `min_interval_seconds` | `10` | Serve the cached frame to `/snapshot/<camera>` requests younger than this (quota guard). `?fresh=1` always captures. |
| `jpeg_quality` | `85` | JPEG quality, 30–100. |
| `capture_timeout_seconds` | `25` | Overall per-capture timeout (answer wait, decode wait). |
| `warmup_frames` | `3` | Decoded frames to skip before capturing. The add-on additionally waits (up to 5 s) for the stream to ramp to HD — Nest sessions start at 640×360 and switch to 1920×1080 once Chrome's bandwidth estimate has grown. |
| `out_dir` | `/config/www/nest` | Where JPEGs are written (atomically, tmp + rename). |
| `crops` | – | Space-separated fixed regions of interest: `camera_name:x:y:w:h` with fractions of the frame, e.g. `hallway_cam:0.35:0.0:0.28:0.55`. Each capture also writes `<camera>_crop.jpg`. |
| `samples_dir` | – | If set (e.g. `/homeassistant/www/nest/samples`), every capture's crop is archived as `<samples_dir>/<camera>/<timestamp>.jpg`, capped at 2000 files per camera. Training data for the classifiers. |

## HTTP API (port 8098)

```
GET /snapshot/<camera>                 capture now; cached if younger than min_interval_seconds
GET /snapshot/<camera>?fresh=1         always capture (one SDM command)
GET /snapshot/<camera>?fresh=1&format=json   capture, return metadata JSON
GET /latest/<camera>.jpg               last capture from disk, 404 if none
GET /                                  status JSON
GET /health                            liveness
```

`<camera>` is the entity id without the `camera.` prefix. The JSON metadata
includes `meanLuma` (the black-placeholder failure this add-on exists to
eliminate measures ~6; real frames measure far higher — guard your
automations with `meanLuma > 3`), and, when a model is deployed for the
camera, `classifier: {label, score, positive}`.

## Per-camera classifiers

Drop a trained weights file at `/config/nest_models/<camera>.json` and every
capture with a crop is scored in-process (microseconds, pure JS). Train with
`tools/train_door_model.py` from the repository: collect crops of the two
states via `samples_dir`, sort them into two directories, run the script,
copy the JSON over — it hot-reloads on file change, no restart needed.

Practical training notes from real use:

- Start with a handful of frames per state; fold in every miss as a new
  labelled sample and retrain — two minutes end to end.
- Collect across lighting (day, dusk, night/IR) before trusting it at night.
- Mind confusers: another door/object entering the crop can mimic your
  target. Add such frames as hard negatives; the residual-vs-reference
  features separate states by *where* change happens, which handles this
  well.
- Set `threshold` (in the JSON) around 0.9 when false positives are worse
  than false negatives, and double-confirm in the automation (re-capture
  after 30–60 s) for persistent states like "door left open".

## Broken supervised installs

Two workarounds are built in for supervised installs with an unhealthy
Supervisor:

- **No `SUPERVISOR_TOKEN` injected** (seen with "Docker misconfigured"
  repairs): put a long-lived HA access token in
  `<config>/.nest_headless_token`; the add-on then connects directly to
  `ws://homeassistant:8123/api/websocket`.
- **No journal gateway** (empty add-on Log tab): create the empty marker file
  `<config>/nest_headless_log_to_file` and the add-on logs to
  `<config>/nest_headless_boot.log` instead.
