#!/usr/bin/env sh
# Server log goes to a file reachable over the config share: this supervised
# install has no journal gateway, so `Log` in the add-on UI shows nothing.
# Outside the supervisor (e.g. a Mac on the LAN) set HA_CONFIG_DIR to the
# mounted HA config share and OPTIONS_FILE to a copy of the add-on options.
CFG="${HA_CONFIG_DIR:-/homeassistant}"
LOG="${LOG_FILE:-$CFG/nest_headless_boot.log}"
touch "$LOG" 2>/dev/null || LOG=/config/nest_headless_boot.log
touch "$LOG" 2>/dev/null || LOG=/tmp/boot.log
exec >> "$LOG" 2>&1   # append: the audit trail (LISTEN, DENIED, IDENTITY) must survive restarts
echo "[nest_headless] ---- start $(date -u +%Y-%m-%dT%H:%M:%SZ) ----"
set -e

# This Supervisor (flagged "Docker misconfigured") injects NO env vars into
# new containers — no SUPERVISOR_TOKEN. Until that repair lands, fall back to
# a long-lived HA token read from the mapped config dir, talking to HA core
# directly on the internal network instead of the supervisor proxy (which
# only accepts SUPERVISOR_TOKEN).
TOKEN_FILE="${TOKEN_FILE:-$CFG/.nest_headless_token}"
# API_TOKEN / API_TOKEN_FILE (bearer for the sensitive routes off-loopback) pass straight through to node
if [ -z "$SUPERVISOR_TOKEN" ] && [ -z "$HA_TOKEN" ] && [ -f "$TOKEN_FILE" ]; then
  export HA_TOKEN="$(cat "$TOKEN_FILE")"
  export HA_WS_URL="${HA_WS_URL:-ws://homeassistant:8123/api/websocket}"
fi

OPTS="${OPTIONS_FILE:-/data/options.json}"
if [ -f "$OPTS" ]; then
  export MIN_INTERVAL_SECONDS="$(jq -r '.min_interval_seconds // 10' "$OPTS")"
  export JPEG_QUALITY="$(jq -r '.jpeg_quality // 85' "$OPTS")"
  export CAPTURE_TIMEOUT_SECONDS="$(jq -r '.capture_timeout_seconds // 25' "$OPTS")"
  export WARMUP_FRAMES="$(jq -r '.warmup_frames // 3' "$OPTS")"
  OUT_DIR_OPT="$(jq -r '.out_dir // ""' "$OPTS")"
  [ -n "$OUT_DIR_OPT" ] && export OUT_DIR="$OUT_DIR_OPT"
  CROPS_OPT="$(jq -r '.crops // ""' "$OPTS")"
  [ -n "$CROPS_OPT" ] && export CROPS="$CROPS_OPT"
  SAMPLES_OPT="$(jq -r '.samples_dir // ""' "$OPTS")"
  [ -n "$SAMPLES_OPT" ] && export SAMPLES_DIR="$SAMPLES_OPT"
  # Persistent watch mode (see DOCS): cameras, surface regions, sensitivity
  WATCHES_OPT="$(jq -r '.watch_cameras // ""' "$OPTS")"
  [ -n "$WATCHES_OPT" ] && export WATCHES="$WATCHES_OPT"
  WATCH_ROIS_OPT="$(jq -r '.watch_rois // ""' "$OPTS")"
  [ -n "$WATCH_ROIS_OPT" ] && export WATCH_ROIS="$WATCH_ROIS_OPT"
  WATCH_PASSAGES_OPT="$(jq -r '.watch_passages // ""' "$OPTS")"
  [ -n "$WATCH_PASSAGES_OPT" ] && export WATCH_PASSAGES="$WATCH_PASSAGES_OPT"
  export WATCH_DIFF_PCT="$(jq -r '.watch_diff_pct // 4' "$OPTS")"
  export WATCH_COOLDOWN_SECONDS="$(jq -r '.watch_cooldown_seconds // 60' "$OPTS")"
  export WATCH_CLASSIFY_SECONDS="$(jq -r '.watch_classify_seconds // 15' "$OPTS")"
  export WATCH_CLASSIFY_PERSIST_TICKS="$(jq -r '.watch_classify_persist_ticks // 16' "$OPTS")"
  export SAMPLE_ARCHIVE_SECONDS="$(jq -r '.sample_archive_seconds // 120' "$OPTS")"
  AUDIO_OPT="$(jq -r '.audio_cameras // ""' "$OPTS")"
  [ -n "$AUDIO_OPT" ] && export AUDIO_CAMERAS="$AUDIO_OPT"
  export SPEECH_SILENCE_MS="$(jq -r '.speech_silence_ms // 800' "$OPTS")"
  export SPEECH_MAX_SECONDS="$(jq -r '.speech_max_seconds // 15' "$OPTS")"
  STT_OPT="$(jq -r '.stt_model_dir // ""' "$OPTS")"
  [ -n "$STT_OPT" ] && export STT_MODEL_DIR="$STT_OPT"
  STT_URL_OPT="$(jq -r '.stt_url // ""' "$OPTS")"
  [ -n "$STT_URL_OPT" ] && export STT_URL="$STT_URL_OPT"
  export IDENTITY_KEEP_SAMPLES="$(jq -r '.identity_keep_samples // false' "$OPTS")"
fi

exec node "$(cd "$(dirname "$0")" && pwd)/app/server.js"
