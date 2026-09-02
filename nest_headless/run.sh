#!/usr/bin/env sh
# Server log goes to a file reachable over the config share: this supervised
# install has no journal gateway, so `Log` in the add-on UI shows nothing.
LOG=/homeassistant/nest_headless_boot.log
touch "$LOG" 2>/dev/null || LOG=/config/nest_headless_boot.log
touch "$LOG" 2>/dev/null || LOG=/tmp/boot.log
exec > "$LOG" 2>&1
set -e

# This Supervisor (flagged "Docker misconfigured") injects NO env vars into
# new containers — no SUPERVISOR_TOKEN. Until that repair lands, fall back to
# a long-lived HA token read from the mapped config dir, talking to HA core
# directly on the internal network instead of the supervisor proxy (which
# only accepts SUPERVISOR_TOKEN).
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
  export WATCH_CLASSIFY_PERSIST_TICKS="$(jq -r '.watch_classify_persist_ticks // 16' "$OPTS")"
  export SAMPLE_ARCHIVE_SECONDS="$(jq -r '.sample_archive_seconds // 120' "$OPTS")"
  AUDIO_OPT="$(jq -r '.audio_cameras // ""' "$OPTS")"
  [ -n "$AUDIO_OPT" ] && export AUDIO_CAMERAS="$AUDIO_OPT"
fi

exec node /app/server.js
