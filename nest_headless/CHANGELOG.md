# Changelog

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
