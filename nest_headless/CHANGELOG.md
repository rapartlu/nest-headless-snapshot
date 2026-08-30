# Changelog

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
