#!/usr/bin/env sh
set -e

# Optional: mirror all output to a file in the HA config dir. Useful on
# supervised installs without systemd-journal-gatewayd, where the add-on Log
# tab shows nothing. Enable by creating the empty marker file
#   <config>/nest_headless_log_to_file
if [ -f /homeassistant/nest_headless_log_to_file ] || [ -f /config/nest_headless_log_to_file ]; then
  LOG=/homeassistant/nest_headless_boot.log
  touch "$LOG" 2>/dev/null || LOG=/config/nest_headless_boot.log
  exec > "$LOG" 2>&1
fi

# Workaround for supervised installs whose Supervisor fails to inject env
# vars into add-on containers (no SUPERVISOR_TOKEN, seen on installs flagged
# "Docker misconfigured"): put a long-lived HA access token in
#   <config>/.nest_headless_token
# and the add-on talks to HA core directly instead of the supervisor proxy.
# On healthy installs SUPERVISOR_TOKEN is present and this block is skipped.
if [ -z "$SUPERVISOR_TOKEN" ] && [ -z "$HA_TOKEN" ] && [ -f /homeassistant/.nest_headless_token ]; then
  export HA_TOKEN="$(cat /homeassistant/.nest_headless_token)"
  export HA_WS_URL="${HA_WS_URL:-ws://homeassistant:8123/api/websocket}"
fi

OPTS=/data/options.json
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
  export WATCH_DIFF_PCT="$(jq -r '.watch_diff_pct // 4' "$OPTS")"
  export WATCH_COOLDOWN_SECONDS="$(jq -r '.watch_cooldown_seconds // 60' "$OPTS")"
  export WATCH_CLASSIFY_SECONDS="$(jq -r '.watch_classify_seconds // 15' "$OPTS")"
fi

exec node /app/server.js
