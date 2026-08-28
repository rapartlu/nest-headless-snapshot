// nest-twcc-probe
//
// Tests one hypothesis: Google's Nest WebRTC sender never ramps past
// bandwidth-probe padding unless the receiver emits transport-wide
// congestion control (TWCC) feedback. Chrome implements TWCC and works;
// aiortc and go2rtc do not send TWCC feedback and receive only 0-byte
// padding. pion/webrtc's default interceptor chain *does* generate TWCC
// receiver feedback, so this probe is the minimal library client that
// matches Chrome's congestion-feedback behaviour.
//
// It performs exactly the handshake proven to work in Chrome:
//   - m-line order: audio, video, application (data channel)
//   - offer sent over Home Assistant's websocket API (camera/webrtc/offer)
//   - Google's empty ICE foundation ("a=candidate: ") patched before use
//
// and then reports, live, whether video RTP arrives with actual payload.
//
// Usage:
//   nest-twcc-probe -ha http://homeassistant.local:8123 \
//     -token <long-lived-access-token> \
//     -entity camera.kitchen_camera \
//     -duration 20s -out /tmp/nest
//
// Prints "HYPOTHESIS SUPPORTED" if video payload bytes arrive.
package main

import (
	"crypto/tls"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media/samplebuilder"
)

var verbose bool

func logf(format string, a ...any) {
	fmt.Printf("[%s] %s\n", time.Now().Format("15:04:05.000"), fmt.Sprintf(format, a...))
}

func vlogf(format string, a ...any) {
	if verbose {
		logf(format, a...)
	}
}

// ---------------------------------------------------------------- HA websocket

type haMsg struct {
	ID      int             `json:"id,omitempty"`
	Type    string          `json:"type"`
	Success *bool           `json:"success,omitempty"`
	Event   json.RawMessage `json:"event,omitempty"`
	Error   json.RawMessage `json:"error,omitempty"`
}

type webrtcEvent struct {
	Type      string          `json:"type"` // session | answer | candidate | error
	Answer    string          `json:"answer,omitempty"`
	SessionID string          `json:"session_id,omitempty"`
	Candidate json.RawMessage `json:"candidate,omitempty"`
	Code      string          `json:"code,omitempty"`
	Message   string          `json:"message,omitempty"`
}

type haClient struct {
	conn   *websocket.Conn
	nextID int
}

func dialHA(haURL, token string, insecure bool) (*haClient, error) {
	u, err := url.Parse(haURL)
	if err != nil {
		return nil, fmt.Errorf("bad -ha url: %w", err)
	}
	scheme := "ws"
	if u.Scheme == "https" || u.Scheme == "wss" {
		scheme = "wss"
	}
	wsURL := fmt.Sprintf("%s://%s/api/websocket", scheme, u.Host)
	dialer := *websocket.DefaultDialer
	if insecure {
		dialer.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
	}
	logf("connecting to %s", wsURL)
	conn, resp, err := dialer.Dial(wsURL, http.Header{})
	if err != nil {
		if resp != nil {
			return nil, fmt.Errorf("websocket dial: %w (http %d)", err, resp.StatusCode)
		}
		return nil, fmt.Errorf("websocket dial: %w", err)
	}

	// auth_required -> auth -> auth_ok
	var m map[string]any
	if err := conn.ReadJSON(&m); err != nil {
		return nil, fmt.Errorf("read auth_required: %w", err)
	}
	if m["type"] != "auth_required" {
		return nil, fmt.Errorf("expected auth_required, got %v", m["type"])
	}
	if err := conn.WriteJSON(map[string]string{"type": "auth", "access_token": token}); err != nil {
		return nil, err
	}
	if err := conn.ReadJSON(&m); err != nil {
		return nil, fmt.Errorf("read auth reply: %w", err)
	}
	if m["type"] != "auth_ok" {
		return nil, fmt.Errorf("authentication failed: %v — check the long-lived access token", m)
	}
	logf("authenticated to Home Assistant (version %v)", m["ha_version"])
	return &haClient{conn: conn, nextID: 1}, nil
}

func (h *haClient) send(payload map[string]any) (int, error) {
	id := h.nextID
	h.nextID++
	payload["id"] = id
	return id, h.conn.WriteJSON(payload)
}

// ---------------------------------------------------------------- SDP patching

// Google's answer contains "a=candidate: ..." with an empty foundation
// field (6 of 6 candidates on this camera). Chrome tolerates it; strict
// parsers do not. Give the candidates a foundation before use.
func patchEmptyFoundation(sdp string) string {
	if n := strings.Count(sdp, "a=candidate: "); n > 0 {
		logf("patched %d empty ICE foundation(s) in remote SDP", n)
	}
	return strings.ReplaceAll(sdp, "a=candidate: ", "a=candidate:nestfix ")
}

func patchCandidateInit(c string) string {
	return strings.Replace(c, "candidate: ", "candidate:nestfix ", 1)
}

// ---------------------------------------------------------------- main

func main() {
	haURL := flag.String("ha", "http://homeassistant.local:8123", "Home Assistant base URL")
	token := flag.String("token", "", "Home Assistant long-lived access token (or env HA_TOKEN)")
	entity := flag.String("entity", "camera.kitchen_camera", "camera entity_id")
	duration := flag.Duration("duration", 20*time.Second, "how long to receive before reporting")
	outDir := flag.String("out", ".", "directory for received H.264 bitstream")
	insecure := flag.Bool("insecure", false, "skip TLS verification")
	remb := flag.Uint64("remb", 2_500_000, "REMB bitrate to advertise (bps), 0 disables")
	flag.BoolVar(&verbose, "v", false, "verbose logging")
	flag.Parse()

	if *token == "" {
		*token = os.Getenv("HA_TOKEN")
	}
	if *token == "" {
		fmt.Println("error: provide -token or HA_TOKEN")
		os.Exit(2)
	}
	if err := os.MkdirAll(*outDir, 0o755); err != nil {
		fmt.Println("error:", err)
		os.Exit(2)
	}

	if err := run(*haURL, *token, *entity, *duration, *outDir, *insecure, *remb); err != nil {
		logf("FATAL: %v", err)
		os.Exit(1)
	}
}

func run(haURL, token, entity string, duration time.Duration, outDir string, insecure bool, rembBps uint64) error {
	// ---- pion setup: default codecs + DEFAULT INTERCEPTORS.
	// RegisterDefaultInterceptors is the whole point of this probe: it
	// installs twcc.SenderInterceptor (generates transport-cc feedback
	// for received packets), NACK, and RTCP receiver reports, and
	// registers the transport-cc RTCP feedback + header extension on the
	// receive codecs so they are negotiated in the offer.
	mediaEngine := &webrtc.MediaEngine{}
	if err := mediaEngine.RegisterDefaultCodecs(); err != nil {
		return err
	}
	registry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(mediaEngine, registry); err != nil {
		return err
	}
	api := webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine), webrtc.WithInterceptorRegistry(registry))

	// Chrome's working control used `new RTCPeerConnection()` with no ICE
	// servers — Google's media host is directly reachable. Match it.
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return err
	}
	defer pc.Close()

	pc.OnICEConnectionStateChange(func(s webrtc.ICEConnectionState) { logf("ICE state: %s", s) })
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) { logf("peer connection state: %s", s) })

	// ---- counters
	var (
		audioPkts, audioPayload         atomic.Int64
		videoPkts, videoPayloadPkts     atomic.Int64
		videoPayloadBytes, videoMarkers atomic.Int64
		videoSamples, videoSampleBytes  atomic.Int64
		firstPayloadOnce                atomic.Bool
	)

	h264Path := filepath.Join(outDir, "probe_"+strings.ReplaceAll(entity, ".", "_")+".h264")

	pc.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		kind := track.Kind().String()
		logf("track: kind=%s payloadType=%d codec=%s ssrc=%d",
			kind, track.PayloadType(), track.Codec().MimeType, track.SSRC())

		if kind == "audio" {
			go func() {
				for {
					pkt, _, err := track.ReadRTP()
					if err != nil {
						return
					}
					audioPkts.Add(1)
					if len(pkt.Payload) > 0 {
						audioPayload.Add(1)
					}
				}
			}()
			return
		}

		// video
		ssrc := uint32(track.SSRC())

		// PLI until payload arrives (known to be insufficient alone, kept
		// as belt and braces) and a REMB advertisement, alongside TWCC.
		go func() {
			t := time.NewTicker(2 * time.Second)
			defer t.Stop()
			for range t.C {
				if pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
					return
				}
				pkts := []rtcp.Packet{}
				if !firstPayloadOnce.Load() {
					pkts = append(pkts, &rtcp.PictureLossIndication{MediaSSRC: ssrc})
				}
				if rembBps > 0 {
					pkts = append(pkts, &rtcp.ReceiverEstimatedMaximumBitrate{
						Bitrate: float32(rembBps), SSRCs: []uint32{ssrc},
					})
				}
				if len(pkts) > 0 {
					_ = pc.WriteRTCP(pkts)
				}
			}
		}()

		go func() {
			f, ferr := os.Create(h264Path)
			if ferr != nil {
				logf("cannot create %s: %v", h264Path, ferr)
			} else {
				defer f.Close()
			}
			sb := samplebuilder.New(200, &codecs.H264Packet{}, track.Codec().ClockRate)
			logged := 0
			for {
				pkt, _, err := track.ReadRTP()
				if err != nil {
					return
				}
				videoPkts.Add(1)
				if pkt.Marker {
					videoMarkers.Add(1)
				}
				if len(pkt.Payload) > 0 {
					videoPayloadPkts.Add(1)
					videoPayloadBytes.Add(int64(len(pkt.Payload)))
					if firstPayloadOnce.CompareAndSwap(false, true) {
						logf(">>> FIRST VIDEO PAYLOAD: seq=%d %d bytes — Google is sending real media",
							pkt.SequenceNumber, len(pkt.Payload))
					}
					sb.Push(pkt)
					for {
						s := sb.Pop()
						if s == nil {
							break
						}
						videoSamples.Add(1)
						videoSampleBytes.Add(int64(len(s.Data)))
						if f != nil {
							_, _ = f.Write(s.Data)
						}
					}
				} else if verbose && logged < 5 {
					logf("video padding pkt seq=%d payload=0", pkt.SequenceNumber)
					logged++
				}
			}
		}()
	})

	// ---- proven m-line order: audio, video, then data channel (application)
	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio,
		webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
		return err
	}
	if _, err := pc.AddTransceiverFromKind(webrtc.RTPCodecTypeVideo,
		webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionRecvonly}); err != nil {
		return err
	}
	if _, err := pc.CreateDataChannel("dataSendChannel", nil); err != nil {
		return err
	}

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		return err
	}
	gatherDone := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		return err
	}
	select {
	case <-gatherDone:
	case <-time.After(10 * time.Second):
		logf("warning: ICE gathering incomplete after 10s, sending offer anyway")
	}
	localSDP := pc.LocalDescription().SDP

	// Confirm what this probe is offering that aiortc/go2rtc did not.
	logf("offer m-lines: %s", strings.Join(mLines(localSDP), " "))
	logf("offer includes transport-cc feedback: %v", strings.Contains(localSDP, "transport-cc"))
	logf("offer includes TWCC header extension: %v",
		strings.Contains(localSDP, "transport-wide-cc-extensions"))

	// ---- Home Assistant handshake
	ha, err := dialHA(haURL, token, insecure)
	if err != nil {
		return err
	}
	defer ha.conn.Close()

	subID, err := ha.send(map[string]any{
		"type":      "camera/webrtc/offer",
		"entity_id": entity,
		"offer":     localSDP,
	})
	if err != nil {
		return err
	}

	answered := make(chan struct{})
	var answeredOnce atomic.Bool
	closeAnswered := func() {
		if answeredOnce.CompareAndSwap(false, true) {
			close(answered)
		}
	}
	go func() {
		for {
			_, raw, err := ha.conn.ReadMessage()
			if err != nil {
				vlogf("HA websocket closed: %v", err)
				return
			}
			var msg haMsg
			if json.Unmarshal(raw, &msg) != nil || msg.ID != subID {
				continue
			}
			switch msg.Type {
			case "result":
				if msg.Success != nil && !*msg.Success {
					logf("HA rejected offer: %s", string(msg.Error))
					closeAnswered()
					return
				}
				vlogf("HA accepted subscription")
			case "event":
				var ev webrtcEvent
				if json.Unmarshal(msg.Event, &ev) != nil {
					continue
				}
				switch ev.Type {
				case "session":
					logf("HA session: %s", ev.SessionID)
				case "answer":
					logf("answer received (%d bytes)", len(ev.Answer))
					desc := webrtc.SessionDescription{
						Type: webrtc.SDPTypeAnswer, SDP: patchEmptyFoundation(ev.Answer),
					}
					if err := pc.SetRemoteDescription(desc); err != nil {
						logf("setRemoteDescription FAILED: %v", err)
					} else {
						logf("answer accepted; answer offers transport-cc: %v, TWCC extension: %v",
							strings.Contains(ev.Answer, "transport-cc"),
							strings.Contains(ev.Answer, "transport-wide-cc-extensions"))
					}
					closeAnswered()
				case "candidate":
					init := parseCandidate(ev.Candidate)
					if init != nil {
						init.Candidate = patchCandidateInit(init.Candidate)
						if err := pc.AddICECandidate(*init); err != nil {
							vlogf("addIceCandidate: %v", err)
						}
					}
				case "error":
					logf("HA webrtc error: %s %s", ev.Code, ev.Message)
				}
			}
		}
	}()

	select {
	case <-answered:
	case <-time.After(20 * time.Second):
		return fmt.Errorf("no answer from Home Assistant within 20s")
	}

	// ---- receive window with live stats
	deadline := time.After(duration)
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
loop:
	for {
		select {
		case <-tick.C:
			logf("stats: audio %d pkts (%d payload) | video %d pkts, %d payload pkts, %d payload bytes, %d markers, %d samples (%d bytes)",
				audioPkts.Load(), audioPayload.Load(),
				videoPkts.Load(), videoPayloadPkts.Load(), videoPayloadBytes.Load(),
				videoMarkers.Load(), videoSamples.Load(), videoSampleBytes.Load())
		case <-deadline:
			break loop
		}
	}

	// ---- verdict
	fmt.Println()
	fmt.Println("================ RESULT ================")
	fmt.Printf("audio: %d packets, %d with payload\n", audioPkts.Load(), audioPayload.Load())
	fmt.Printf("video: %d packets, %d with payload, %d payload bytes, %d marker bits\n",
		videoPkts.Load(), videoPayloadPkts.Load(), videoPayloadBytes.Load(), videoMarkers.Load())
	fmt.Printf("video samples assembled: %d (%d bytes) -> %s\n",
		videoSamples.Load(), videoSampleBytes.Load(), h264Path)
	if videoPayloadBytes.Load() > 0 {
		fmt.Println()
		fmt.Println("HYPOTHESIS SUPPORTED: with TWCC feedback enabled, Google sends real video.")
		fmt.Println("Convert a still with:  ffmpeg -i " + h264Path + " -frames:v 1 -q:v 2 still.jpg")
		return nil
	}
	fmt.Println()
	fmt.Println("HYPOTHESIS NOT CONFIRMED: still padding-only even with TWCC feedback.")
	fmt.Println("Fall back to the headless Chromium add-on (nest_headless).")
	return nil
}

func mLines(sdp string) []string {
	var out []string
	for _, l := range strings.Split(sdp, "\n") {
		if strings.HasPrefix(l, "m=") {
			out = append(out, strings.Fields(strings.TrimPrefix(l, "m="))[0])
		}
	}
	return out
}

// HA may deliver a candidate as a bare string or as an RTCIceCandidateInit object.
func parseCandidate(raw json.RawMessage) *webrtc.ICECandidateInit {
	if len(raw) == 0 {
		return nil
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return &webrtc.ICECandidateInit{Candidate: s}
	}
	var init webrtc.ICECandidateInit
	if json.Unmarshal(raw, &init) == nil {
		return &init
	}
	return nil
}
