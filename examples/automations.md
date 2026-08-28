# Wiring patterns

Real automations from the household this add-on was built for. Swap in your
own entity ids, AI provider and speakers. The `rest_command` definitions are
in `nest_capture.yaml` in this folder.

## The core pattern: capture, guard, analyze

Call the snapshot endpoint with `?fresh=1&format=json`. It only returns once
the JPEG is saved, so the next step always sees a frame that is seconds old.
If the capture fails, the chain stops, and a stale frame is never analyzed
as current.

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

## Lessons about vision AI prompts (learned the hard way)

- Small vision models answer one-word questions from habit, not from the
  image. Ask "is the door open, answer one word" and you get "CLOSED" no
  matter what the picture shows. Give the model room: ask for one
  descriptive sentence first, then the verdict as the final word, and read
  the last word in a template:
  `{{ ((result.response_text | trim).split() | last) | upper }}`.
  Set `max_tokens` generously, since thinking models spend tokens before
  they answer.
- Check your LLM Vision global system prompt. The default event-summary
  wording ("track changes across images, exclude static details") actively
  fights questions about static things like a door.
- For subtle fixed-scene states, skip the AI entirely and use the add-on's
  built-in classifiers (see DOCS.md). They are instant, free, and can't be
  talked out of what they see.

## Cat-on-the-worktop deterrent with rotating sounds

On kitchen motion: capture, ask the vision model whether a cat is on a
raised surface, and if so send one notification and play a deterrent sound.
Re-check every 25 seconds, playing a different sound each round because cats
quickly get used to any single noise. Give up after 4 rounds, and stop the
moment the cat is down.

Sound tips: pad about a second of silence onto the front of each clip
(`ffmpeg -i in.mp3 -af "adelay=900:all=1,apad=pad_dur=0.2" out.mp3`) so a
smart speaker's wake-up delay swallows silence instead of the sound. You can
make effective deterrent sounds with ffmpeg alone: pulsed white-noise bursts
(the sound commercial cat deterrents use), hisses, sharp clatter, or high
pitched sweeps.

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
        # ... luma guard and llmvision verdict (see above) ...
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

## Door-left-open alert with the built-in classifier

Check every 5 minutes during waking hours, and confirm before announcing. A
door that has been left open stays open, so requiring two positive captures
45 seconds apart costs nothing and cuts false alarms sharply:

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
# ... same check on capture2, then notify and announce ...
```

## Quota arithmetic

Google allows 100 SDM commands per hour per camera. A 5-minute periodic
check uses 12 per hour. A deterrent episode adds up to 4. Motion-triggered
checks are naturally rare. The cache absorbs bursts.
