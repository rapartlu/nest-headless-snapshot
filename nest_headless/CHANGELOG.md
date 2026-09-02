# Changelog

## 1.8.9 (host)

- `host/whisper_server.py`: Whisper large-v3-turbo via Apple MLX behind the
  same `POST /inference` API as whisper.cpp, for `stt_url`. ~0.5-0.7 s per
  utterance on an M3 Pro; `engine` reports `mlx-whisper:whisper-large-v3-turbo`.

## 1.8.9

- Follow-up window (Hearth #4): `POST /listen/<camera>?seconds=8` opens a
  speech capture on that camera as if a wake word had just fired, with the
  same end-pointing and the same `nest_headless_speech` event (`keyword:
  "follow-up"`), for the brain to call right after it has spoken. No tail
  phase, 300 ms pre-roll; if nobody speaks within `seconds` (default 8, max
  30) there is no event at all. 409 while a capture is already open, 404 if
  the camera has no audio tap.
- `speech_max_seconds` default 15 (was 8): it is a safety stop now that
  captures close on silence; 8 s truncated real sentences.

## 1.8.8

- `wake_confirmed` on `nest_headless_speech`: the pre-roll is always given to
  the recogniser and the flag says whether it heard the wake phrase there.
  The spotter is deliberately eager and fires on ordinary talk now and then;
  an unconfirmed capture is still sent (the brain decides) but is cheap to
  discard. The wake phrase is stripped from the transcript as before.

## 1.8.7

- Once speech has been heard, "quiet" is judged relative to that speech
  (18% of the utterance's running peak rms, never below the floor). Kitchen
  bustle at 0.01-0.06 rms sat above the fixed floor and kept captures open
  to the 8 s hard stop for a 3.5 s question (Hearth #3, instrumented). The
  absolute floor still decides whether anything was said at all.

## 1.8.6

- Utterances are peak-normalised (to -3 dBFS, at most x20) before
  recognition: speech from the far side of the kitchen arrives at rms
  0.01-0.08 and Whisper read it as noise (Hearth #3).
- Whisper's bracketed sound tags ("(baby crying)", "[inaudible]") are never
  posted as `text`: the event carries `text: ""` with `reason: "unclear"`.
- `stt_url`: optional whisper.cpp `whisper-server` (POST /inference over
  loopback, audio never touches disk) used ahead of the in-process model,
  with automatic fallback when unreachable. `engine: "whisper.cpp"`.

## 1.8.5

- Speech noise floor = the ring's quietest tenth x3, clamped to 0.006-0.015:
  a ring full of conversation or a spoken answer had lifted it to ~0.1,
  above a normal voice, producing false `no_speech`. The 1.2 s run-on
  fallback now counts the run-on as speech already (Hearth #3). Transcripts
  that begin with the bare wake name are stripped too.

## 1.8.4

- 1.5 s pre-roll on speech captures (was 300 ms): the spotter fires 0.3-0.7 s
  after the wake phrase, so someone who runs straight on has already said
  the start of the question. When no gap follows the wake phrase the
  pre-roll is kept for the recogniser and the wake phrase is stripped from
  the transcript (`stripWakePhrase`, spellings cover how the recognisers
  render "Claude": Claws, God, Cloud, ...).

## 1.8.3

- Whisper transcripts. Point `stt_model_dir` at a sherpa-onnx Whisper model
  directory (`<name>-encoder*.onnx`, `<name>-decoder*.onnx`,
  `<name>-tokens.txt`; e.g. `sherpa-onnx-whisper-small.en`) and the add-on
  transcribes with it in-process: small.en int8 takes ~0.6 s per utterance
  on an M3 Pro and turned tonight's far-field captures into "Hey kitchen, is
  the understair cupboard open?" where the transducers gave fragments.
  Transcripts stay authoritative in the add-on (Hearth #3). Hosts without a
  Whisper dir keep the transducer fallback. `nest_headless_speech` gains
  `engine`, `stt_ms` and `final: true`; Whisper text keeps its casing and
  punctuation.

## 1.8.2

- Speech end-pointing (Hearth #3): the pre-roll and the first 300 ms after
  the keyword hit are recogniser input only, never evidence that the question
  has started; up to 3 s of initial quiet is allowed (people wait for an
  acknowledgement); at least 500 ms of voiced audio is required before
  `speech_silence_ms` of quiet can close the capture; `speech_max_seconds`
  is the hard stop. Previously the wake phrase's own tail satisfied "has
  spoken" and the natural pause after it closed the window 0.2-1.1 s after
  the hit, before the question began.
- `GET /utterance/<utterance_id>.wav`: the 16 kHz mono audio behind a
  `nest_headless_speech` event, memory-held for 90 s, so the brain can run a
  stronger recogniser (Whisper on real hardware). The event carries
  `audio_path` and `audio_ttl_s`. Nothing is written to disk.
- Local transcript falls back to the keyword spotter's own gigaspeech
  transducer (already resident) when `stt_model_dir` is unset: on far-field
  kitchen audio it transcribed a question the LibriSpeech en-20M model
  returned "" for. It is a rough fallback, not the product.
- Runs outside the Supervisor. `HA_CONFIG_DIR` points at a mounted HA config
  share, `OPTIONS_FILE` at a copy of the add-on options, `HA_WS_URL` +
  `HA_TOKEN` (or `<config>/.nest_headless_token`) at HA; bundled assets
  resolve relative to `app/`; macOS Chrome is found automatically. See DOCS
  "Running on a Mac". On an M3 Pro the cat detector runs in ~160 ms versus
  3.5-4.7 s on a 2-core NAS.
- onnxruntime uses all cores again (the 1.8.1 `cpus - 1` cap only slowed
  detection; nice 10 alone protects the browser). Note that an unprivileged
  process cannot lower its nice back, so a Chromium relaunch after a browser
  crash inherits nice 10 until the container restarts.

## 1.8.1

- Fixed keyword spotting dying under load. Inference (onnxruntime, sherpa)
  shares the container with Chromium; when it saturated the host, Chromium's
  WebRTC receiver missed its audio deadlines and the jitter buffer expanded
  to silence, so the mic audio reached the spotter as intact words separated
  by dead gaps that no phrase survived (measured: a continuous 3.5 s phrase
  arrived as bursts over 6.5 s). Chromium is now spawned at nice 0 and the
  Node process lowers itself to nice 10 after launch, so the browser always
  wins CPU contention; onnxruntime sessions are capped to `cpus - 1`
  intra-op threads. `GET /` reports `cpus`, `nice`, `load` and `capturing`
  (cameras with a speech capture in progress).

## 1.8.0

- Voice identity (Hearth issue #2). Each `nest_headless_speech` utterance is
  followed by `nest_headless_identity` {utterance_id, speaker: {quality,
  matches: [{name, score}]}, faces: []} using a 3D-Speaker ERes2Net
  embedding (`nest_models/identity/models/speaker.onnx`), cosine against
  enrolled people. `GET /identity` lists people; `POST /identity/voice/enrol`
  {camera, name, utterance_id?} enrols from a recent utterance (kept 90 s in
  memory); `DELETE /identity/<name>` forgets. Embeddings are stored as JSON
  under `nest_models/identity/<name>/`; raw WAV only with
  `identity_keep_samples: true`. `utterance_id` added to
  `nest_headless_speech`. Face identity is reserved for a later release.

## 1.7.0

- Speech-to-text after a keyword hit: the utterance following the phrase is
  captured (300 ms pre-roll; ends on `speech_silence_ms` of quiet after
  speech or at `speech_max_seconds`) and recognised with a sherpa-onnx
  streaming zipformer hot-loaded from `nest_models/stt/` (`stt_model_dir`).
  One event: `nest_headless_speech` {camera, keyword, text, duration_ms,
  started_at, ended_at, reason: silence|max_seconds|no_speech}. Audio stays
  in memory; keyword hits are suppressed on that camera during a capture.
- `GET /frame/<camera>`: instant JPEG off the held stream with no persist,
  detect or archive side effects (~0.5 s). `/snapshot` remains the archiving
  path.
- Fixed `GET /latest/<camera>.jpg` resetting the connection: the file is
  rewritten every second by the watch loop, so stat-then-stream raced the
  writer; it is now read whole and sent.
- `people` (COCO person count, conf >= 0.5) on `/detect` responses and on
  `nest_headless_surface_activity`. No new event.
- Audio tap moved to an AudioWorklet (ScriptProcessor dropped every other
  buffer under page load, corrupting speech); watch pages load from
  `http://127.0.0.1:<port>/blank` because AudioWorklet needs a secure context.

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
