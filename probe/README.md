# nest-twcc-probe

The minimal hypothesis test for the "server-side clients get only zero-byte
padding from Nest WebRTC cameras" problem. A single static Go binary using
pion/webrtc v4 with its default interceptor chain, which — unlike aiortc and
go2rtc — **generates TWCC receiver feedback**, negotiates the `transport-cc`
RTCP feedback attribute and the transport-wide-cc header extension, and
additionally sends periodic PLI and a REMB advertisement.

One run costs **one** SDM command against the 100/hour/camera quota and takes
about two minutes:

```
cd src && go build -o nest-twcc-probe .
./nest-twcc-probe \
  -ha http://homeassistant.local:8123 \
  -token '<long-lived-access-token>' \
  -entity camera.your_camera \
  -duration 20s -out /tmp/nest
```

What to look for, in order:

- `offer includes transport-cc feedback: true` — the probe is offering what
  aiortc/go2rtc could not.
- `answer accepted; answer offers transport-cc: ...` — the key diagnostic.
  If Google's answer does not echo transport-cc, the feedback loop never
  engaged and a padding-only result is inconclusive about the mechanism.
- `>>> FIRST VIDEO PAYLOAD` — hypothesis confirmed in one line.
- The `RESULT` block with full packet accounting.

On success it writes an annex-B H.264 bitstream; convert a still with:

```
ffmpeg -i /tmp/nest/probe_camera_your_camera.h264 -frames:v 1 -q:v 2 still.jpg
```

In our measured run: 2867/2867 video packets with payload (3.15 MB in 20 s),
with the stream switching from 640×360 to 1920×1080 after 3 frames — against
the identical camera/account where go2rtc and aiortc received 1707/1707
empty-payload packets.

`src/cmd/mockha` is a fake HA websocket endpoint backed by a pion sender used
to test the probe end-to-end (auth flow, offer/answer, simulated
empty-foundation candidates, ICE/DTLS, RTP receive, H.264 reassembly) without
touching Google or spending quota.
