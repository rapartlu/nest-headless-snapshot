# Changelog

## 1.4.4

- Cold-start hardening: watch hits are ignored for 45 s after a stream
  (re)connects - a settling stream (exposure/resolution ramp) diffs like
  motion and fired a phantom deterrent seconds after a restart. The
  person-recently memory is also seeded at connect instead of starting
  empty.

## 1.4.3

- Suspected-cat now also requires that no person has been detected for 45
  seconds: someone walking out of frame between two samples reads as
  motion-with-nobody-present and fired a false deterrent within minutes of
  the heuristic shipping.

## 1.4.2

- Suspected-cat heuristic: pretrained COCO detectors have a real blind spot
  for climbing, motion-blurred, partly occluded animals on distant surfaces
  (a plainly visible worktop raid went undetected at 10% confidence). When a
  surface region shows motion and NO person is detected anywhere in the
  frame, the event now fires with `cat: "suspected"` and the annotated
  evidence frame is archived. People trip the motion diff constantly but
  detect very reliably, so daytime cooking stays silent.

## 1.4.1

- Fixed: the surface-motion watch loop never actually fired. Functions passed
  to page.evaluate lose their module scope, so the hit path's frame-grab call
  threw ReferenceError into a silent catch on every trigger since the feature
  shipped. The helper is now installed into the page's global scope first.
  Also adds `GET /watchstate/<camera>` (loop ticks, hits, max diff seen) so a
  silent watch can never masquerade as a quiet room again.

## 1.4.0

- Capture timeline: every archived frame is indexed in
  `samples/<camera>/timeline.json` (rolling 300 entries) with its verdicts,
  detections, confidences and luma. Full-frame cameras get a box-annotated
  copy (`*_a.jpg`) alongside each archived frame. Because the samples dir
  lives under `www/`, a dashboard card can render the whole history -
  `examples/capture-timeline-card.js` ships a ready-made Lovelace card:
  thumbnails, chips for each detection/verdict, click to expand.

## 1.3.1

- Evidence never vanishes any more: cameras without a crop archive their full
  frames to `samples_dir` (same two-minute throttle and rotation cap as the
  crop archive), so any frame that led to a decision can be reviewed later.
  Cat-positive events additionally archive their box-annotated snapshot
  per-event with no throttle, and the alert notification image points at the
  annotated copy - the alert itself shows where the animal was and how
  confident the detector felt.

## 1.3.0

- Base image moved from Alpine to Debian (bookworm) so native
  onnxruntime-node loads - local vision models now run in-process,
  multithreaded. First build after the switch is slow (new base plus a full
  Debian Chromium); later rebuilds hit the Docker cache.
- Local cat detection: a YOLO11n COCO model (place it at
  `app/assets/models/yolo11n.onnx` before building - see DOCS, the weights
  are AGPL so they are not shipped in this repo) checks every surface-motion
  hit and the new `GET /detect/<camera>` endpoint. Detection zooms each
  watched region (a distant cat is invisible at full-frame scale but detects
  at high confidence when the region is zoomed) and requires the animal's
  feet inside the region - so people leaning over the worktop and cats
  walking the floor behind it stay silent. The surface-activity event now
  fires only when a cat or dog is actually on a surface, and carries the
  detections.
- Per-camera CNN classifiers: drop a fine-tuned `<camera>.onnx` (ultralytics
  classify export) next to the linear model in `nest_models/` and it takes
  over the verdict - hot-loaded on change, with the linear model still
  supplying the framing tripwire. A CNN trained across lighting regimes and
  camera framings is dramatically more robust than the linear template.
- Classifier persistence gate: `watch_classify_persist_ticks` (default 16)
  requires ~85% positive ticks across the window plus three consecutive
  positives before the classifier event fires. "Left open" is a persistent
  state; hallway traffic and lighting flips are not.

## 1.2.1

- Watch mode: hold a persistent WebRTC stream open per listed camera
  (`watch_cameras`, e.g. `kitchen_camera:4`). Home Assistant keeps extending
  the Google session, so sampling the live video costs no per-check API
  command and snapshots return in well under a second instead of dialing for
  8-12 s. Only use this for cameras on mains power - a held stream will
  drain a battery camera quickly.
- Surface-motion events: define regions with `watch_rois`
  (`camera:name@x:y:w:h;...` as frame fractions). When the changed-pixel
  share in a region passes `watch_diff_pct`, the add-on writes the frame and
  fires the `nest_headless_surface_activity` event ({camera, roi,
  changed_pct}) for automations - built for a fast cat-on-worktop deterrent.
  `watch_cooldown_seconds` limits the event rate.
- Classifier ticks: watched cameras that have a crop and a trained model are
  scored from the live stream every `watch_classify_seconds`; a positive
  verdict (framing check permitting) fires `nest_headless_classifier_positive`
  ({camera, label, score}) - a door left open is now caught in seconds, not
  on the next poll.
- Snapshot fast path: `/snapshot/<camera>` serves from the live watch stream
  when one is running (`frames: -1` in the JSON meta), falling back to a
  normal one-shot dial.
- Sample archiving is throttled to one frame per two minutes per camera so
  frequent watch captures do not flood the training archive.
- Watch status is reported in the `/` status JSON under `watches`.

## 1.1.0

- Wait for the stream's HD ramp (640×360 → 1920×1080) before capturing,
  capped at 5 s so captures stay fast (~6 s warm).
- Fixed-region crops per camera (`crops` option) written as
  `<camera>_crop.jpg`.
- Sample archiving (`samples_dir` option) for classifier training data.
- Tiny per-camera classifiers: JSON weights in `/config/nest_models/`,
  hot-reloaded, scored per capture in pure JS; verdict exposed in capture
  metadata.
- Workarounds for unhealthy supervised installs: token-file fallback when
  the Supervisor injects no `SUPERVISOR_TOKEN`; opt-in file logging when no
  journal gateway exists.

## 1.0.0

- Initial release: headless-Chromium WebRTC capture against HA's
  `camera/webrtc/offer` API, JPEG snapshots over HTTP and to
  `/config/www/nest/`, capture coalescing, quota guard, mean-luma black-frame
  reporting, proven m-line order and empty-ICE-foundation patch.
