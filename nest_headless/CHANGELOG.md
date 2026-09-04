# Changelog

## 1.18.7

- `tools/retrain_zones.py` never replaces a zone model with one whose
  leave-one-out accuracy is lower by more than `--worse-by` (0.02); the
  rejection is recorded in the stamp and not retried until the labels change
  (`--allow-worse` overrides). A batch of mislabelled crops had taken the
  fridge model from 0.977 to 0.905 overnight (#22).
- The trainer detects a changed label set by a signature of the file names,
  not the counts alone: a crop moved from one label to the other retrains.
- Zone models are judged on balanced recall, not accuracy: with fifteen
  closed frames per open one, "always closed" scores 0.94 before it has
  learned anything (#22). The trainer reports each class's recall.
- The guard compares a new model against the one in place on the frames the
  latter has never seen, not against a score stored from a smaller corpus.
  The old comparison kept a model scoring 0.45 balanced on unseen frames
  over one scoring 0.72.

- `GET /archive/<camera>/<time>.jpg` serves the whole frame (`_f`) of a
  camera that archives a crop, not the crop itself (#30). The hallway's
  1.5 KB "thumbnail" was its door crop.

## 1.18.6

- A cat is named on a detection only when the match is decisive (>= 0.92
  and 0.03 clear of the runner-up), the rule that already decides the
  backlog; the top score alone had named one ginger cat as the other at
  0.908.

## 1.18.5

- A house can name its assistant (#29): `wake_names` (the names accepted
  after the wake word by the transcript path and the wake confirmation, a
  `|` list that may contain spaces for the way recognisers split an
  unfamiliar name) and `wake_canon` (`name=alias|alias;name2=...`, mapping
  what the spotter or recogniser heard to the keyword text the brain
  expects, e.g. `HEY BOT BEARD` -> `HEY BOTBEARD`). The spotter's own
  phrases stay in `nest_models/keywords.txt` (BPE token lines; a greedy
  segmentation over `tokens.txt` plus a few split variants was enough for a
  new two-syllable name to fire in four synthesised voices and never on the
  old name). Both wake words can run side by side while a household
  switches.

## 1.18.0 - 1.18.4

- Blue/green deploys on the Mac (no sensing gap). `host/supervise.sh` is
  what launchd runs: it keeps one instance on the main port and, on
  `touch <state dir>/deploy.request`, starts the new code beside it on a
  spare port (`PORT`, `HANDOVER_FROM`, `TARGET_PORT`). The new instance
  dials its own streams, waits until the watches the old one has live are
  up and settled (45 s, capped at 150 s), asks the old one to drain
  (`POST /admin/handover`, loopback only: events stop there at once, open
  captures finish, then it exits), and opens a second listener on the main
  port the moment it frees. Events are held back while standby and start
  the instant the old stops, so the house hears each moment once. `GET /`
  shows `role`, `role_since`, `events_held`, `listen_port`, `pid`.
  Measured: 103 s from request to switch, 0 s without HTTP, both cameras
  live throughout; the old way cost 20-60 s blind per restart plus a
  Google command per camera and the occasional minute-long retry.
  (1.18.1-1.18.3: the standby had targeted itself from a shell expansion
  order, waited on a camera the vendor app has off, and then took three
  minutes closing its spare listener behind Chromium's keep-alive sockets -
  each fixed in turn; the fallback kept the old instance up every time.)

## 1.17.5

- Backlog removals are restart-safe: the entry's metadata is unlinked
  first and synchronously, the media and folder follow; the loader
  finishes any removal a restart interrupted (a folder without metadata).
  A deleted entry had come back after a restart and been labelled from a
  stale card.

## 1.17.4

- The one-face-per-camera-per-minute backlog guard is reserved before the
  crop is cut, so two detection paths on the same frame no longer park the
  same face twice.

## 1.17.3

- `POST /training/<set>/<label>/<file>/move {label}` relabels a training
  crop from the review (#28): the file moves under the new label (folder
  created if new), replacing a same-named file there as the newer verdict;
  answers `{ok, url, replaced}`. Same token rule and path validation as
  `DELETE`.

## 1.17.2

- Enrolments and sample deletions update the in-memory identity index
  instead of re-reading the whole identity directory; the directory (on a
  share) is read once at boot, asynchronously. Every cat enrolment had been
  a 2.5 s synchronous re-read of 96 files on the event loop.

## 1.17.1

- Hold a state zone's change detection while a person covers it (#27):
  `hold_covered` (fraction of the zone under a person box, default 0.5, 0
  disables) and `hold_near` (also while a person stands within half a
  zone-width, default on) per state zone in `zones.json` / `PUT /zones`.
  While held, the pre-visit reference is kept and the people there are
  noted; once the zone has been clear and settled for the usual ticks, one
  `nest_headless_zone_change` is judged against that reference, carrying
  `held_s` and `people_during`, with the before crop from before the visit
  and the after crop from now. Trained-model `zone_state` is unaffected.
  Numbers behind it: 47 dryer-door changes in two hours, 42 with a person
  in front and the door unchanged.

## 1.17.0

- Zone states from the model's labels (#26): a zone model may have any
  number of states (`open`, `vent`, `closed` for a dishwasher whose door is
  left ajar to steam off). `tools/train_zone_model.py` trains a
  multinomial version of the linear template matcher from one folder per
  label (leave-one-out over the originals as before), `retrain_zones.py`
  uses it for any zone with three or more label folders, and
  `classifier.js` answers with `label`, `scores` per label and `labels`.
  `nest_headless_zone_state.state` is the label name, `scores` and
  `labels` ride on the event and on `zone_change.model`; a flip still needs
  consecutive agreeing ticks. Binary models are unchanged.

## 1.16.3

- Cat enrolment's duplicate guard ignores stale (older-descriptor) samples,
  so re-enrolling the same photo after a descriptor change is accepted.

## 1.16.2

- Cat descriptor v2 (#23): the detection box's colour histogram has its
  surroundings (the crop's margin ring) subtracted, and coat and texture
  come from the box's inner 60 %, so a small cat on a grey worktop is
  described by its coat rather than the worktop. v1 had named a ginger cat
  as the black one at 0.917 because both crops were mostly kitchen. Samples
  carry `v`; older ones are listed (`stale` on the cat summary) but never
  matched - re-enrol them. A name is given only once at least two cats have
  current samples: with one cat in the gallery every animal is its best
  match.

## 1.16.1

- Archive retention by age (#25): heartbeat frames for `archive_days` (7),
  frames behind events, hits, cat evidence and zone composites for
  `evidence_days` (30); the count caps stay as a safety net sized to those
  windows. `GET /archive/<camera>/<time>.jpg` also searches the cat and hit
  archives (box-annotated copies), preferring a raw frame in range and
  saying `X-Frame-Annotated: true` otherwise. Three of last night's cat
  cards that 404'd now resolve.

## 1.16.0

- The recognition corpus for review (#24): `GET /identity/<name>/samples`
  (and `/identity/cat/<name>/samples`) lists every enrolled sample with
  kind, time, source, camera, size or speech length, quality, pose and a
  `media_url` when its media is kept; `GET .../samples/<id>/media` serves
  the JPEG or WAV; `DELETE .../samples/<id>` removes the sample and its
  embedding and re-indexes. With `identity_keep_samples` on, face samples
  now keep a context crop (the face box with 2.5x margin) rather than the
  aligned 112 px thumbnail, so a person can judge them.
- `training_dir`: a brain's labelled training crops
  (`<dir>/<camera>__<zone>/<label>/*.jpg`) are served read-only under
  `/training` (listing, per-label listing, files) with `DELETE` of a single
  crop, so a wrong label can be dropped before the nightly retrain. Token
  rule as for identity; the add-on never writes there.

## 1.15.1

- Cat enrolment refuses a near-identical sample (`reason: duplicate`, cosine
  >= 0.995 with one already held) and caps a cat at 200 samples, oldest
  photo first. Seven of the first fourteen samples sent for one cat were
  exact repeats.

## 1.15.0

- Cat identity (#23), the same flow as people: `POST /identity/cat/enrol`
  {name, camera, index?} from the current frame or {name, image_b64} from a
  photo or labelled crop (refusals `no_cat`, `cat_too_small` with
  `size_px`/`needed_px`, `multiple_cats` with candidates), `GET /identity`
  lists `cats: [{name, samples, room, upload, last_seen}]`, `GET
  /identity/cat/<name>`, `DELETE /identity/cat/<name>`. Every cat detection
  on `nest_headless_surface_activity` carries `who: {name|null, score,
  matches, size_px}` and the event a top-level `who` for the best cat (the
  boolean `cat` is unchanged); `GET /identity/who/<camera>` adds `cats`.
  Ambiguous cats go to the backlog as `kind: "cat"` and label like faces.
  The descriptor (`catid.js`) is a colour histogram plus coat, texture and
  size terms on the box's inner 60 %, no neural model; a photo sample has
  no frame so it matches on colour and texture only. Naming line 0.9,
  decisive 0.92 with 0.03 clear of the runner-up.

## 1.14.3

- A zone model whose leave-one-out accuracy is under 0.8 keeps reporting its
  view on `nest_headless_zone_change` (`model`) but no longer announces
  state flips as `nest_headless_zone_state`: a coin-flip verdict is noise,
  not a sense. The log says "model below trust floor - not announced".

## 1.14.2

- Per-zone state models without a CNN (#22): where no `<camera>__<zone>.onnx`
  exists, a `<camera>__<zone>.json` from `tools/train_door_model.py` (the
  linear template matcher, `--subcrop 0,0,1,1` for a whole zone crop) drives
  `nest_headless_zone_state` the same way, hot-loaded on change.
  `tools/retrain_zones.py` retrains every `<camera>__<zone>/{open,closed}/`
  label folder under a root whenever its counts change (a nightly job),
  skipping frames labelled both ways, and the trainer's new `--loo` prints
  a leave-one-out accuracy over the original frames - the honest number
  with few samples. Zone events carry `model`/`engine`/`loo_acc`/`samples`
  so a consumer can decide how far to trust the verdict.

## 1.14.1

- Memory: the MLX recogniser workers cap their Metal buffer cache
  (`MLX_CACHE_LIMIT_MB`, default 256) and clear it after every request.
  Three Parakeet workers had grown to 8 GB each on an hour of
  varying-length audio and pushed the Mac 25 GB into swap, at which point
  both recogniser servers timed out and captures fell to the in-process
  model. Two Parakeet workers and one Whisper worker now.
- Segment path brakes: a room that is never quiet (an appliance, a TV)
  raises the segment floor to 1.6x the minute's median level instead of
  being chopped into an endless stream of segments; outside a reply window
  at most 8 segments a minute per camera are transcribed
  (`segments_throttled`), and after 3 consecutive recogniser failures the
  path pauses for a minute (`segments_paused`). One warning per 5 minutes.

## 1.14.0

- Evidence by reference (#21). Every frame the add-on judges is noted in a
  per-camera memory ring, and the frames behind events are written to the
  archive under `<camera>_events/`; `GET /archive/<camera>/<time>.jpg`
  (ISO, stamp or epoch ms; `?within=ms`, default 120 s) answers with the
  nearest frame from memory, the event archive or the heartbeat archive
  (`X-Frame-At`, `X-Frame-Source`, `X-Frame-Distance-Ms`).
- Events carry `frame_at` and `boxes` (`[{label, score?, name?, x, y, w, h}]`
  in frame fractions): passage (passage zone, tracked person, faces),
  passage_look (faces), zone_change and zone_state (zone, people nearby),
  surface_activity (surface, detections), speech (faces sampled at the
  wake, when already in hand) and identity (`frame_at`).
- Zone changes keep a before|after composite under
  `<camera>_zones/<zone>/` and name it on the event as `look_url`;
  `GET /look/zones/<camera>/<zone>/<time>.jpg` serves the nearest.
- Utterances the house was addressed on stay in memory for 24 h (cap 300,
  oldest out; gone on restart) instead of 90 s; `audio_ttl_s` says which.

## 1.13.5

- Second look as a series (#7): `look: {camera, delay_ms, until_ms (<= 8 s),
  every_ms (>= 500), min_face_px (60)}` takes frames from the held stream
  between `delay_ms` and `until_ms` and stops at the first face large
  enough to identify; one `nest_headless_passage_look` reports the best
  result, or the largest face seen with `reason: face_too_small`, or
  `no_face`, plus `attempts` and `at_ms`. First live look found a 28 px
  face at 1.5 s: the person is still by the door then.

## 1.13.4

- Passage events carry `faces`: every face in the frame (>= 40 px) with
  `box`, `size_px`, `det_score`, `matches` (when large enough to embed) and
  `name`/`score` at >= 0.4, matched or not; `person` gains `name`, `score`,
  `size_px` (#7).
- Second look: a passage may name a camera to look from after a crossing,
  `look: {camera, delay_ms?}` in `zones.json` (settable through `PUT
  /zones`), for doorways where the face is small from the watching camera
  but large from the room's own. Its faces go out as
  `nest_headless_passage_look` with the same `track_id` (#7).

## 1.13.3

- Transcript wake path: a segment must carry the full wake phrase ("hey"
  plus the name); the bare-name rule stays reserved for spotter captures
  whose pre-roll can cut the "hey". A hallway sentence beginning "kitchen
  speaker" had passed as a wake.

## 1.13.2

- Latency: the speculative transcription starts at 250 ms of closing quiet
  (was 350), its text goes out as `nest_headless_speech_partial`
  (`final: false`, only for captures the house was addressed on) so a brain
  can start its turn before the window closes, and a transcript ending in a
  question mark closes the capture at 400 ms of quiet instead of the full
  `speech_silence_ms`. A sentence two microphones hear is transcribed once:
  the second camera's segment is dropped and its spotter capture skips the
  speculative pass (`twinOf`). Measured before: duplicate calls queued on
  the recogniser and pushed 0.2 s transcriptions to 1.2-1.6 s.

## 1.13.1

- `POST /identity/voice/who` {audio_b64, format?} -> {quality, matches,
  decisive} (#19): who is speaking in an uploaded clip, scored exactly as
  `speaker.matches` on the identity event; >= 1 s voiced needed
  (`too_short` otherwise); the clip is matched in memory and not kept.
  Uploaded audio for this and for voice enrolment may be WAV or, where the
  host has `afconvert` or `ffmpeg`, m4a/caf/aac/mp3 (`format`).

## 1.13.0

- Transcript wake path (`wake_by_transcript`, off by default): every speech
  segment on a tapped microphone (`segments.js`: onset above the noise
  floor, short pre-roll, closed by relative quiet, 15 s cap) is transcribed
  in memory and judged on its text. A wake phrase at the head makes it a
  keyword hit (`nest_headless_keyword` with `source: transcript`) and the
  speech event in one go, with the transcript already in hand; anything
  else is dropped with nothing kept, logged or sent. Motivation: the 3 MB
  spotter decoded a loud, close "Hey Claude" as "I glob" and could never
  match it, while the recogniser heard it perfectly. The spotter still runs
  (it is faster on the phrases it does catch); the two paths never report
  the same utterance twice. Speech events carry `wake_source`.
- Conversation windows: `POST /listen/<camera>?mode=conversation&seconds=N`
  (needs the option; up to 60 s) makes the next speech segment on that
  microphone the reply, so a person can pause and start again without a
  wake phrase. One reply closes the window; `DELETE /listen/<camera>`
  closes it early (do that before the speaker plays). The plain `/listen`
  capture is unchanged. `GET /` shows open windows under `conversations`
  and per-camera counters `segments`, `segment_wakes`,
  `segment_follow_ups`, `segments_dropped`.

## 1.12.9

- Spotter diagnostics on `GET /` under `audio.<camera>`: `decodes`,
  `lastKeyword`, `lastKeywordAt`, `streamRefreshes`; a spotter stream that
  has run 10 minutes without a detection is recreated during quiet.
  (Investigating missed wake phrases: the process and the model were fine;
  the small spotter simply mis-hears some loud, close utterances, e.g. a
  near-clipping "Hey Claude" decoded as "I glob".)

## 1.12.8

- `stt_fallback_url`: a second recogniser server tried when `stt_url`
  fails, ahead of the in-process one, so two engines can stay warm with one
  primary. `host/stt_switch.sh parakeet|whisper` swaps them and restarts.
- Bake-off outcome in the authors' house: Parakeet (parakeet-tdt-0.6b-v3
  via MLX) is now primary, Whisper large-v3-turbo the fallback. Over a day
  of paired transcripts Parakeet was as accurate on commands, better on
  names, and returned an empty string on near-silence where Whisper
  invented text ("Thank you.", a looping phrase) four times.

## 1.12.7

- A watched camera that the vendor app has switched off (every offer answers
  `FAILED_PRECONDITION: not available for streaming`) is retried every
  5 minutes instead of every 30 s: each retry was a Google command against
  that camera's hourly quota and a warning line.

## 1.12.6

- "Not a person" label for the backlog (#18): `POST
  /identity/pending/<id>/not_person` moves a false face (poster, reflection,
  the cat) or non-speech clip (TV, a dog) into a hard-negative set under
  `nest_models/identity/negatives/not_person/` and answers `{ok, pending,
  negatives}`. A new candidate whose embedding is within the decisive margin
  of a stored negative is dropped before it reaches the backlog and is never
  matched to a person. `GET /identity/negatives` lists the set, `DELETE
  /identity/negatives/<id>` removes one; `GET /identity` carries the count.
  Kept until deleted (cap 500); the crops are there for a detector retune.

## 1.12.5

- Backlog and auto room samples only from speech addressed to the house:
  a capture whose wake word Whisper did not confirm, outside a follow-up
  window, no longer parks a clip or keeps a sample. A spotter false alarm
  on background conversation had queued a 4 s clip of it.

## 1.12.4

- Confident room voice matches keep a room sample (#16 follow-up, approved
  by the household admin): when a capture scores >= 0.6 with a clear margin,
  its embedding is stored as `source: room, auto: true`. Embeddings only,
  never audio; at most 12 auto samples per person, one per ten minutes,
  oldest auto sample displaced first, explicit enrolments and admin labels
  never displaced. `identity_auto_samples: false` turns it off.
  `GET /identity/<name>` reports the count under `voice_sources.auto`.
- Identity sample writes are async and update the in-memory index directly
  instead of re-reading the identity directory (a share) each time.

## 1.12.3

- The real cause behind #17: synchronous disk I/O on a network share. The
  Mac runs against the NAS over SMB, where a sync `readdir` of a 2000-file
  archive directory took 2.6 s and every 250 KB write 70-180 ms, each one on
  the event loop. Two to three seconds of lag followed every archive tick,
  delaying audio and the status route. All hot-path disk work now goes
  through `diskq.js`: `fs.promises`, serialised per file or directory,
  atomic latest-wins writes for the www/ stills and timelines, and directory
  listings read once and kept in memory (`DirIndex`). The verification
  backlog keeps its index in memory the same way. `UV_THREADPOOL_SIZE=8` in
  the Mac launchd plist gives the async I/O headroom.
- `annotate()` (box-drawn evidence frames) is async and draws through sharp
  as an SVG overlay; the JS decode-paint-encode stays as the fallback.
- Identity samples carry `source`: `room` (a camera microphone or frame) or
  `upload` (phone recording or photo). Voice matches report `room` and
  `upload` bests alongside the unchanged `score`; `GET /identity/<name>`
  adds `voice_sources` and `face_sources` counts (#16 follow-up).
- The identity directory is read at boot rather than during the first
  conversation.
- sharp was in package.json but had never been installed in the Mac
  checkout; the docs now say to run `npm install` there.

## 1.12.2

- Event-loop lag guard (#17): the loop's lag is measured every 500 ms and
  reported as `loop_lag_ms` on `GET /`; while it exceeds 400 ms the optional
  vision work (passage detection, zone ticks, face sampling, backlog
  candidates) yields for that tick, so the status route and the audio path
  stay responsive. A 20-minute 100% spin during a phone onboarding burst had
  made `/` take 1.5 s.
- Uploaded enrolment images are EXIF-rotated and capped at 1600 px before
  face detection (a 12 MP phone photo decoded raw is ~48 MB).
- 1.12.1: uploaded enrolment clips are peak-normalised before the voiced test.

## 1.12.0

- Verification backlog for identity (#16). A voice capture or a face of good
  quality whose match is ambiguous (voice best < 0.6, face best < 0.5, or a
  runner-up within 0.1) or unknown is parked under
  `<config>/nest_models/identity/pending/<id>/` with its embedding, the clip
  (16 kHz WAV, <= 10 s) or a context crop (JPEG), and `meta.json`; kept 7
  days or 200 samples, oldest dropped; at most one face candidate per camera
  per minute. `nest_headless_identity_pending` {count, newest?} fires on add
  and after any label/drop.
- Endpoints (loopback or API token): `GET /identity/pending?kind=&camera=&limit=`,
  `GET /identity/pending/<id>/media`, `POST /identity/pending/<id>/label
  {name}` (enrols the sample, creating the person), `POST
  /identity/pending/<id>/unknown` (not a household member: a 30-day negative
  set stops the same visitor being queued again), `DELETE
  /identity/pending/<id>`.
- Onboarding inputs: `POST /identity/voice/enrol` accepts `{name, audio_b64,
  phrase?}` (16-bit WAV, any rate/channels, 3-10 s); `POST /identity/face/enrol`
  accepts `pose` (front|left|right|up|down) and returns `poses_held`;
  `GET /identity/<name>` -> {voice_samples, face_samples, poses_held,
  last_matched}. `GET /identity` reports `pending`.
- 1.11.9: house-specific text scrubbed; `WAKE_NAMES` env override.

## 1.11.7

- Activity zones ignore people (Hearth #12 field note): before a zone goes
  `running`, a fresh frame is checked for a person box covering >= 25% of
  the zone; if someone is there the zone stays idle and the window resets -
  a real drum cycle keeps turning after they walk away. Three 19-84 s
  "cycles" on 3 Sept were people loading the machine.
- 1.11.6: with passages configured, any motion in the frame feeds the
  tracker (persistent tracks between doorways); per-ROI `minPct`.

## 1.11.5

- Quiet speech (Hearth #15): when the end-pointer would report `no_speech`
  but the post-wake audio carried faint energy (> 0.6x the floor) for at
  least 600 ms, the recogniser is run anyway; words found are posted with
  `reason: "quiet_speech"`, nothing found stays `no_speech`. A quiet voice across
  a large room speaks at rms 0.01-0.02, right at the floor, and was getting
  "didn't catch that" most of the time.
- 1.11.4: wake-phrase stripping only at the head of the transcript.

## 1.11.3

- `concurrent_cameras` on `nest_headless_speech`: other cameras whose capture
  started within 1.5 s of this one - the same voice reaching two microphones
  (two rooms' microphones both heard the same wake word). The
  brain dedupes on it.
- `host/whisper_server.py` keeps its model workers warm (a silent decode
  every `KEEP_WARM_S`, default 240 s): after seven idle hours the first
  utterance of the day took 5-8 s while weights paged back in.
- 1.11.2: optional zone `description` kept in `zones.json` and returned by
  `GET /zones`.

## 1.11.1

- Zone editor API for the app. `GET /zones` returns every zone of every kind
  per camera (surfaces, passages, state, activity), each as a polygon (`pts`)
  or a rect, plus which cameras are watched. `PUT /zones` {cameras:
  {<camera>: {surfaces?, passages?, state?, activity?}}} validates, replaces
  the given kinds for the given cameras, saves `<config>/nest_models/zones.json`
  and hot-applies to live watches (the page motion mask restarts; streams
  stay up; trackers and zone references reset). Writes need loopback or the
  API token; reads are open. `zones.json` overrides the option strings at
  start-up, so app edits survive restarts.
- Every zone kind accepts polygons: state zones now mask their change
  fingerprint to the drawn shape.

## 1.11.0

- State zones (Hearth #12, #13), the senses/intelligence split made
  explicit: `watch_classify_zones: "camera:name@x:y:w:h;..."` names crops
  the add-on watches every 2 s against a reference look. A sustained change
  (2 ticks over `zone_change_threshold` on a 48x48 grey fingerprint) posts
  `nest_headless_zone_change` {camera, zone, t, diff, reference_held_s,
  before_jpeg_b64, after_jpeg_b64, people_nearby: [{box, height_ratio,
  name|null, score, matches}], recent_names} - the brain decides what the
  change means (a door opened, what was taken). No per-appliance training.
  If a trained model exists for a zone (`<camera>__<zone>.onnx`, classes
  closed/open) the tick also posts debounced `nest_headless_zone_state`
  {state, previous, score, previous_duration_s, people_nearby}.
- Activity zones: `watch_activity_zones` names crops whose per-tick change
  is reported from the page loop; a 20-tick window with hysteresis posts
  `nest_headless_activity` {zone, state: running|idle, previous_duration_s,
  mean_pct} - a drum turning behind glass.
- `GET /` shows per-zone diff/reference age/last change and activity state.

## 1.10.6

- `stt_shadow_url`: a second recogniser that receives every utterance in
  parallel; its text is only logged (`SHADOW` lines), never used or posted.
  For bake-offs on real household audio without keeping recordings.
- `host/whisper_server.py` gains `STT_ENGINE=parakeet-mlx` (NVIDIA
  Parakeet-TDT 0.6B v3 via parakeet-mlx, in-memory log-mel + generate, no
  disk) alongside `mlx-whisper`, and always serves from worker processes
  (MLX streams are bound to their creating thread). Parakeet transcribes a
  4.6 s clip in ~0.15-0.27 s on an M3 Pro versus ~0.70 s for
  whisper-large-v3-turbo.
- 1.10.5: follow-up speech events carry `opened_by` and `open_reason`.

## 1.10.4

- API authentication for the sensitive routes (Hearth #10): `/listen`,
  `/identity`, `/utterance`, `/audiodebug` are loopback-only unless the
  caller presents `Authorization: Bearer <API_TOKEN>` (`API_TOKEN` or
  `API_TOKEN_FILE`). Denials are logged with the caller's address. Snapshot,
  frame, detect and status routes stay LAN-open for Home Assistant.
- Every `POST /listen` is logged with the caller's address, optional
  `?reason=`, and timestamp; the log file is now appended across restarts
  (with a start marker) so the audit trail survives.
- Fixed a 1.10.3 regression that made every speech capture fail after the
  transcription refactor (`total is not defined`).

## 1.10.3

- Faster turn-around: transcription starts speculatively after 350 ms of
  closing silence; if nobody speaks again before the window closes, the
  event goes out with the result already in hand (~0.5 s sooner). The
  speech event carries `speculative` and `close_to_event_ms`. Example
  config drops `speech_silence_ms` to 600.

## 1.10.2

- `POST /identity/face/enrol` accepts a supplied image (Hearth #9): JSON
  `{name, image_b64, index?}` (a data URL prefix is tolerated) enrols from
  a frame the brain already holds instead of a live grab; `camera` becomes
  optional. Same detector, size rule, refusals and storage; `bad_image` for
  undecodable input. JSON bodies up to 8 MB.

## 1.10.1

- Classifier health made explicit (Hearth #8): `classifier.state` is `ok`,
  `dark` (mean luma < 3) or `framing_drift` (linear engine's reference gate
  only), and `nest_headless_health` {camera, classifier_state, previous}
  fires when it changes. The ONNX door verdict no longer carries the linear
  model's `framingOk`/`refCorr`: that reference predates the laser-slice crop,
  so it read `false` permanently while meaning nothing for the CNN.

## 1.10.0

- Face identity (Hearth #2, second half). SCRFD (10g) detection + 5-point
  alignment + ArcFace (w600k_r50) 512-d embeddings, hot-loaded from
  `nest_models/identity/models/{scrfd_10g.onnx, arcface_w600k_r50.onnx}`
  (InsightFace buffalo_l), ~45 ms per 1080p frame on CoreML. During a speech
  capture the camera's frame is sampled at the wake moment and 1 s later;
  `nest_headless_identity.faces` becomes `[{name|null, score, box, quality:
  {size_px, det_score, reason}, matches: [{name, score}]}]`, largest first.
  `name` is set at cosine >= 0.4 (same person here ~0.5-0.8, strangers
  ~0.1-0.3); the top-3 is always included. `GET /identity/who/<camera>`
  answers from one fresh frame. `POST /identity/face/enrol` {camera, name,
  index?} enrols the face in view; refusals: `no_face`, `face_too_small`
  (< 60 px, with `size_px`/`needed_px`), `multiple_faces` (lists candidates
  with `index`). Embeddings as JSON under `nest_models/identity/<name>/`;
  an aligned 112x112 crop only with `identity_keep_samples`.
- `nest_headless_passage.person.matches` is filled from the face inside the
  crossing person's box when one is visible.
- `GET /identity` reports `face_samples` per person and `face_models`.

## 1.9.0

- Passage zones (Hearth #7). `watch_passages` takes polygons drawn across
  doorways, same syntax as `watch_rois` plus an optional inside point:
  `downstairs_hallway_camera:downstairs_toilet@x1,y1:x2,y2:x3,y3:x4,y4|in=x,y;front_door@...`.
  A passage joins the camera's motion mask; every doorway-motion hit runs
  the person + bag detector (8 ms on CoreML, own 0.7 s pacing) through a
  per-camera tracker (IoU / foot-distance matching, 4 s track life). When a
  tracked person's feet go through the polygon - or vanish inside it, the
  usual case when the room behind the door is out of view - one
  `nest_headless_passage` event is posted: {camera, passage, direction
  in|out|across, track_id, t, person: {matches: []}, attributes:
  {height_ratio, carrying: "bag"|null}}. One event per track and passage per
  2 s; turning back in the doorway posts nothing. Passages are never cat
  surfaces. `GET /` lists `passages` and live `tracks` per watch.
- Face identity moves to 1.10.0.

## 1.8.12

- CoreML execution provider on macOS (`ORT_COREML=0` to disable): on an M3
  Pro the cat model runs in 18 ms (was 67), the person model in 8 ms (was
  25), the door classifier in 1 ms (was 4). Sessions are warmed at start-up
  (~2.3 s) so the first live detection does not pay the compile.
- JPEG decoding moved off the event loop: `sharp` (libvips, native, async)
  replaces jpeg-js for detection and door classification. A 1080p decode was
  ~90 ms of blocking JavaScript per detection; it is now ~10 ms in a worker.
  jpeg-js remains for annotation and the legacy classifier.
- Measured `/detect` (capture + decode + both models) on the Mac: 0.18-0.25 s
  (was ~0.40 s).
- 1.8.11: the Node process no longer lowers its own priority on hosts with
  six or more cores; both camera microphones enabled in the Mac config.

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
  (18% of the utterance's running peak rms, never below the floor). Room
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
  the cupboard open?" where the transducers gave fragments.
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
  be a NIGHT REFLECTION on a glass door mislabelled as a cat (identical
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
