# Changelog

## 1.6.0

- Action phrases from the camera microphone. The WebRTC session has always
  carried the camera's audio track; `audio_cameras` now taps it in-page
  (AudioWorklet-style PCM chunks -> Node) and runs a sherpa-onnx keyword
  spotter (3.3M-param zipformer, ~2% of a core, sub-second) for the phrases
  in `app/assets/kws/keywords.txt` (defaults: "hey kitchen", "hey claude").
  A hit fires `nest_headless_keyword` {camera, keyword}. Audio is processed
  in memory only - nothing is ever written to disk. Custom phrases: encode
  with the model's `bpe.model` via sentencepiece (see DOCS).
- Kitchen sampling defaults to 1 s in the example config; static TTS
  phrases should use `cache: true` so repeat announcements skip generation.
- Note for local add-on installs: the supervisor caches the options schema
  per version - bump `version` and run the add-on update (not just a
  rebuild) when options change, or new keys are silently dropped.

## 1.5.9

- Detection latency is now bounded at ~6-10s from animal-on-surface to
  event, regardless of prior activity: the watch cooldown used to gate
  DETECTION (any motion blinded the zone check for the next 60s - a person
  passing 30s before the cat meant the cat went unseen). Detection now
  paces at 8s whenever motion is present; `watch_cooldown_seconds` throttles
  only repeat alerts.

## 1.5.8

- Polygon zones: `watch_rois` accepts `name@x1,y1:x2,y2:x3,y3...` alongside
  the rectangular `name@x:y:w:h`. Motion is masked to the drawn shape, the
  feet-on-surface test ray-casts the polygon, and alert annotations draw
  the true outline. Rectangles bleed onto the floor behind counters under
  camera perspective; polygons trace the actual surface edges.

## 1.5.7

- Cat detection runs FULL-FRAME, the way the house model was trained. The
  region-zoom path (1.3.0-1.5.6) fed the fine-tuned model crops ~3x larger
  than its training distribution - a train/serve scale mismatch that both
  missed a real cat in daylight and let a wipes tub fire at zoom scale.
  (Zoom remains for the COCO fallback, which needs it for small cats.)
- COCO cross-examination: when the house model claims a cat, the stock COCO
  model checks the same box - if it identifies a bottle/cup/vase/bowl there
  and sees no cat itself, default knowledge vetoes the call. Fine-tuning on
  a small set trades away COCO's broad "what things are"; this buys it back.
- Cat detector v6: night-lighting wipes-tub hard negative.

## 1.5.6 / 1.5.5

- Every surface-motion hit now archives a box-annotated evidence frame to
  samples/<camera>_hits/ (10s throttle, rolling 600) whatever the verdict -
  "a cat was just there, did you catch it?" is now answerable with frames
  instead of forensics. Heartbeat archive default stays configurable.
- Door classifier: threshold 0.30 (laser-slice CNN margins: closed 0.00-0.03,
  settled opens 0.98+; in-between door angles sat at 0.5-0.8 and flapped
  across the old 0.6 line so the persistence gate never fired).

## 1.5.4

- The framing tripwire no longer vetoes CNN classifier verdicts. A wide-open
  door occludes the reference region and pins refCorr near zero - the gate
  muted an hour of score-1.00 "door open" verdicts, which is precisely the
  state the classifier exists to catch. CNNs trained across framings need no
  alignment gate; refCorr stays in the capture meta as a camera-moved
  telltale. The linear engine keeps the veto.

## 1.5.3

- Cat detection confidence threshold raised 0.40 -> 0.50: a person's head at
  cat-scale in a zoomed surface region scored 0.418 and fired the deterrent;
  every genuine surface cat has scored 0.85+, so the margin is safe.
- Cat detector v4: that head is now a trained hard negative, plus one more
  verified hallway cat the archives were hiding.

## 1.5.2

- Cat detector v3: trained on the first overnight haul from both cameras -
  hallway scene (ginger and a black cat on the hall floor), IR night frames,
  and fresh confusers (boots on the stairs that pattern-match a sleeping
  cat, cookware on the worktop). 20/20 acid cases.
- `sample_archive_seconds` option (default 120): the archive/timeline
  throttle is now configurable, and watched cameras heartbeat-archive at
  that cadence even when nothing moves - a uniform timeline instead of
  motion-dependent gaps. Frames come off the held stream, so a denser
  cadence costs disk, not API quota.

## 1.5.1

- Cat detector v2, trained on every frame in the archive: both day and
  night, all poses (including curled-up eating - a raid pose v1's val split
  had never taught it), with human-verified labels. A v1 label turned out to
  be a NIGHT REFLECTION on the patio glass mislabelled as a cat (identical
  pixels for 3+ hours of frames proved it) - v2 trains against it as a hard
  negative. Acid suite: 14/14, cats 0.92-0.96, all confusers silent.
- Annotated evidence frames (burned-in ROI rectangles) are excluded from
  training data - a detector taught on annotations learns the rectangles.
- Cropped cameras now archive the full frame too (*_f.jpg alongside the
  crop): a camera whose samples are all door crops contributes no
  floor-level animal training data at all.

## 1.5.0

- House-trained cat detector: `detectCats()` now prefers a fine-tuned
  single-class YOLO model at `/app/assets/models/cats.onnx` (960 px input)
  and falls back to COCO cat/dog classes when the file is absent. A model
  fine-tuned on ~30 labelled frames from the actual camera finds the raids
  the pretrained detector was blind to (the missed worktop raid scores 0.93)
  with zero false positives on people, empty rooms, and lamp reflections.
  Training recipe in DOCS (weights are AGPL, build your own).
- Fixed a decode bug in the single-class path: the class filter ran on the
  raw class index before the remap, discarding every detection.
- Removed the suspected-cat motion heuristic (1.4.2-1.4.4): three firings,
  zero cats. Motion-plus-no-person cannot distinguish an animal from a
  settling stream, a person leaving frame, or a lamp reflection. The verdict
  now comes from the detector alone - if the pretrained one misses your cat,
  fine-tune (see DOCS).

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
