module nestprobe

go 1.24.0

toolchain go1.24.7

replace golang.org/x/crypto => github.com/golang/crypto v0.37.0

replace golang.org/x/net => github.com/golang/net v0.39.0

replace golang.org/x/sys => github.com/golang/sys v0.32.0

replace golang.org/x/time => github.com/golang/time v0.11.0

replace golang.org/x/term => github.com/golang/term v0.31.0

replace golang.org/x/text => github.com/golang/text v0.24.0

require (
	github.com/gorilla/websocket v1.5.3
	github.com/pion/interceptor v0.1.47
	github.com/pion/rtcp v1.2.17
	github.com/pion/rtp v1.10.5
	github.com/pion/webrtc/v4 v4.2.19
)

require (
	github.com/google/uuid v1.6.0 // indirect
	github.com/pion/datachannel v1.6.2 // indirect
	github.com/pion/dtls/v3 v3.1.5 // indirect
	github.com/pion/ice/v4 v4.4.0 // indirect
	github.com/pion/logging v0.2.4 // indirect
	github.com/pion/mdns/v2 v2.1.0 // indirect
	github.com/pion/randutil v0.1.0 // indirect
	github.com/pion/sctp v1.11.1 // indirect
	github.com/pion/sdp/v3 v3.0.19 // indirect
	github.com/pion/srtp/v3 v3.0.13 // indirect
	github.com/pion/stun/v3 v3.1.7 // indirect
	github.com/pion/transport/v4 v4.1.0 // indirect
	github.com/pion/turn/v5 v5.0.13 // indirect
	github.com/wlynxg/anet v0.0.5 // indirect
	golang.org/x/crypto v0.48.0 // indirect
	golang.org/x/net v0.50.0 // indirect
	golang.org/x/sys v0.41.0 // indirect
	golang.org/x/time v0.14.0 // indirect
)
