// mockha — a fake Home Assistant websocket endpoint backed by a pion peer
// that answers camera/webrtc/offer and streams a real H.264 file. Used to
// end-to-end test nest-twcc-probe without a camera: auth flow, offer/answer,
// Google-style EMPTY ICE FOUNDATIONS in the answer (simulated), ICE/DTLS,
// RTP receive, sample reassembly, file write.
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/pion/webrtc/v4/pkg/media/ivfreader"
)

var codec string

var upgrader = websocket.Upgrader{}

var h264File []byte

// simulate Google: blank every ICE foundation in the answer SDP
var foundationRe = regexp.MustCompile(`a=candidate:\S+ `)

func main() {
	addr := flag.String("addr", "127.0.0.1:8123", "listen address")
	h264Path := flag.String("media", "sample.h264", "media file: annex-b .h264 or VP8 .ivf")
	flag.StringVar(&codec, "codec", "h264", "h264 | vp8")
	flag.Parse()

	var err error
	h264File, err = os.ReadFile(*h264Path)
	if err != nil {
		log.Fatal(err)
	}
	http.HandleFunc("/api/websocket", handle)
	log.Printf("mock HA listening on %s", *addr)
	log.Fatal(http.ListenAndServe(*addr, nil))
}

func send(c *websocket.Conn, v any) {
	if err := c.WriteJSON(v); err != nil {
		log.Println("write:", err)
	}
}

func handle(w http.ResponseWriter, r *http.Request) {
	c, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer c.Close()

	send(c, map[string]any{"type": "auth_required", "ha_version": "2026.7.3-mock"})
	var auth map[string]any
	if c.ReadJSON(&auth) != nil || auth["type"] != "auth" {
		send(c, map[string]any{"type": "auth_invalid"})
		return
	}
	send(c, map[string]any{"type": "auth_ok", "ha_version": "2026.7.3-mock"})

	for {
		var msg map[string]any
		if c.ReadJSON(&msg) != nil {
			return
		}
		if msg["type"] != "camera/webrtc/offer" {
			continue
		}
		id := int(msg["id"].(float64))
		offer := msg["offer"].(string)
		log.Printf("offer for %v (%d bytes)", msg["entity_id"], len(offer))

		answerSDP, err := startPeer(offer)
		if err != nil {
			log.Println("peer error:", err)
			send(c, map[string]any{"id": id, "type": "result", "success": false,
				"error": map[string]string{"code": "webrtc_offer_failed", "message": err.Error()}})
			continue
		}
		send(c, map[string]any{"id": id, "type": "result", "success": true, "result": nil})
		send(c, map[string]any{"id": id, "type": "event",
			"event": map[string]any{"type": "session", "session_id": "mock-session-1"}})

		// Google-style: blank the foundations
		blanked := foundationRe.ReplaceAllString(answerSDP, "a=candidate: ")
		send(c, map[string]any{"id": id, "type": "event",
			"event": map[string]any{"type": "answer", "answer": blanked}})
	}
}

func startPeer(offerSDP string) (string, error) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return "", err
	}

	mime := webrtc.MimeTypeH264
	if codec == "vp8" {
		mime = webrtc.MimeTypeVP8
	}
	videoTrack, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: mime}, "video", "mock")
	if err != nil {
		return "", err
	}
	audioTrack, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}, "audio", "mock")
	if err != nil {
		return "", err
	}

	if err := pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeOffer, SDP: offerSDP}); err != nil {
		return "", err
	}
	if _, err := pc.AddTrack(audioTrack); err != nil {
		return "", err
	}
	if _, err := pc.AddTrack(videoTrack); err != nil {
		return "", err
	}

	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		log.Println("mock peer state:", s)
		if s == webrtc.PeerConnectionStateConnected {
			go stream(videoTrack, audioTrack)
		}
	})

	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		return "", err
	}
	done := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		return "", err
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
	return pc.LocalDescription().SDP, nil
}

func stream(v *webrtc.TrackLocalStaticSample, a *webrtc.TrackLocalStaticSample) {
	if codec == "vp8" {
		streamIVFLoop(v, a)
		return
	}
	// h264: send the whole annex-b file as a "frame" every 100ms, plus audio ticks
	t := time.NewTicker(100 * time.Millisecond)
	defer t.Stop()
	n := 0
	for range t.C {
		if err := v.WriteSample(media.Sample{Data: h264File, Duration: 100 * time.Millisecond}); err != nil {
			fmt.Println("video write:", err)
			return
		}
		_ = a.WriteSample(media.Sample{Data: []byte{0xf8, 0xff, 0xfe}, Duration: 20 * time.Millisecond})
		n++
		if n > 200 {
			return
		}
	}
}

func streamIVFLoop(v *webrtc.TrackLocalStaticSample, a *webrtc.TrackLocalStaticSample) {
	for loop := 0; loop < 30; loop++ { // ~30x file duration then stop
		r, _, err := ivfreader.NewWith(bytesReader(h264File))
		if err != nil {
			log.Println("ivf:", err)
			return
		}
		t := time.NewTicker(100 * time.Millisecond)
		for range t.C {
			frame, _, err := r.ParseNextFrame()
			if err != nil {
				break // EOF -> loop file for a fresh keyframe
			}
			if werr := v.WriteSample(media.Sample{Data: frame, Duration: 100 * time.Millisecond}); werr != nil {
				t.Stop()
				return
			}
			_ = a.WriteSample(media.Sample{Data: []byte{0xf8, 0xff, 0xfe}, Duration: 20 * time.Millisecond})
		}
		t.Stop()
	}
}

func bytesReader(b []byte) *os.File {
	f, _ := os.CreateTemp("", "ivf")
	f.Write(b)
	f.Seek(0, 0)
	return f
}
