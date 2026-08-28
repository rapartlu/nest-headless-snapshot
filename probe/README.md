# nest-twcc-probe

A small Go program that shows why server-side tools get no video from Nest
WebRTC cameras, using your own camera as the test.

The short version: Google's sender waits for congestion-control feedback
(TWCC) before it sends real video. Browsers send that feedback. go2rtc and
aiortc don't, so they receive empty padding packets forever. This probe uses
pion/webrtc, which does send TWCC feedback, so it receives real video where
those tools receive nothing.

One run takes about two minutes and uses one command from your camera's SDM
quota (100 per hour).

```
cd src && go build -o nest-twcc-probe .
./nest-twcc-probe \
  -ha http://homeassistant.local:8123 \
  -token '<long-lived-access-token>' \
  -entity camera.your_camera \
  -duration 20s -out /tmp/nest
```

What to look for, in order:

- `offer includes transport-cc feedback: true` means the probe is offering
  what go2rtc and aiortc could not.
- `answer accepted; answer offers transport-cc: ...` is the key line. If
  Google's answer does not echo transport-cc, the feedback loop never
  started and a padding-only result proves nothing either way.
- `>>> FIRST VIDEO PAYLOAD` means the theory holds on your camera.
- The `RESULT` block gives the full packet counts.

On success it saves the raw H.264 video. Get a still out of it with:

```
ffmpeg -i /tmp/nest/probe_camera_your_camera.h264 -frames:v 1 -q:v 2 still.jpg
```

For reference, our measured run received 2867 video packets, every one with
payload (3.15 MB in 20 seconds), and the stream jumped from 640x360 to
1920x1080 after 3 frames. The same camera and account gave go2rtc and aiortc
1707 packets with zero payload.

`src/cmd/mockha` is a fake Home Assistant endpoint used to test the probe
end to end without touching Google or spending quota.
