# Wiring patterns

Battle-tested patterns from the household this add-on was built for. Adapt
entity ids, providers and speakers to your setup. `rest_command` definitions
are in `nest_capture.yaml` in this directory.

## The core pattern: capture → guard → analyze

`rest_command` with `?fresh=1&format=json` is synchronous: it returns only
after the JPEG is written, so the next action always sees a frame that is
seconds old, and a failed capture stops the chain — a stale frame is never
analysed as current.

```yaml
- action: rest_command.nest_capture_kitchen
  response_variable: capture
- condition: template
  value_template: "{{ (capture.content.meanLuma | default(255)) | float > 3 }}"
- action: llmvision.image_analyzer
  data:
    image_file: /config/www/nest/kitchen_camera.jpg
    ...
```

## VLM prompting lessons (learned the hard way)

- Small vision models answer **one-word verdict prompts from prior, not
  perception** ("is the door open? answer one word" → "CLOSED" regardless of
  pixels). Give them room: ask for one descriptive sentence first, then the
  verdict as the final word, and parse the last word in a template:
  `{{ ((result.response_text | trim).split() | last) | upper }}` with
  generous `max_tokens` (thinking models need it).
- Check your **LLM Vision global system prompt**: the default event-summary
  prompt ("track changes across images, exclude static details") actively
  sabotages static-state questions.
- For subtle fixed-scene states (a door ajar), skip the VLM entirely — use
  the add-on's built-in classifiers (see DOCS.md). Deterministic, instant,
  free, and it can't be talked out of what it sees.

## Cat-on-the-worktop deterrent with sound rotation

On motion: capture, ask the VLM whether a cat is on a raised surface, and if
so notify once and play a deterrent sound; re-check every ~25 s rotating
through different sounds (cats habituate quickly to any single noise), max 4
rounds, stopping the moment the verdict is clean.

Sound tips: pad ~0.9 s of silence onto the front of each clip
(`ffmpeg -i in.mp3 -af "adelay=900:all=1,apad=pad_dur=0.2" out.mp3`) so a
cast speaker's wake-up delay swallows silence, not the sound. Effective
deterrents can be synthesized with ffmpeg alone — pulsed white-noise bursts
(the commercial "SSSCAT" sound), band-passed hisses, percussive clatter,
pulsed 9–12 kHz sweeps.

```yaml
variables:
  deterrent_sounds:
    - /config/www/cat_deterrent/sscat_pulses.mp3
    - /config/www/cat_deterrent/air_hiss.mp3
    - /config/www/cat_deterrent/clatter.mp3
actions:
  - repeat:
      while: [{ condition: template, value_template: "{{ repeat.index <= 4 }}" }]
      sequence:
        - action: rest_command.nest_capture_kitchen
          response_variable: capture
        # ... luma guard, llmvision verdict (see above) ...
        - if: [{ condition: template, value_template: "{{ verdict not in ['TABLE','BOX'] }}" }]
          then: [{ stop: No cat on a surface }]
        - if: [{ condition: template, value_template: "{{ repeat.index == 1 }}" }]
          then:
            - continue_on_error: true
              action: notify.notify
              data:
                title: "🐱 Cat on the kitchen surfaces!"
                message: "{{ (cat_result.response_text).splitlines() | first }}"
                data: { image: /local/nest/kitchen_camera.jpg }
        - continue_on_error: true
          action: chime_tts.say
          data:
            entity_id: media_player.kitchen_display
            chime_path: "{{ deterrent_sounds[(repeat.index - 1) % (deterrent_sounds | length)] }}"
            message: ""
            announce: false
            volume_level: 1.0
        - delay: { seconds: 25 }
```

## Door-left-open alert with the on-device classifier

Periodic check (time_pattern /5 during waking hours) + double confirmation —
a door *left* open is persistent, so requiring two positive captures 45 s
apart squares the false-alarm odds at negligible cost:

```yaml
- action: rest_command.nest_capture_hallway
  response_variable: capture
- variables:
    door_open: >-
      {{ capture.content.classifier.positive | default(false)
         if capture.content.classifier is defined else false }}
- if: [{ condition: template, value_template: "{{ not door_open }}" }]
  then: [{ stop: Door closed }]
- delay: { seconds: 45 }
- action: rest_command.nest_capture_hallway
  response_variable: capture2
# ... same check on capture2, then notify + TTS announce loop ...
```

## Quota arithmetic

100 SDM commands/hour/camera. A 5-minute periodic check = 12/hour baseline.
Each deterrent episode adds up to 4. Motion-triggered checks are naturally
sparse. `min_interval_seconds` absorbs bursts.
