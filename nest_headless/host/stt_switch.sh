#!/bin/sh
# Swap the primary and backup speech recognisers (Mac mode) and restart the
# add-on. Both servers stay running; only which one is asked first changes.
#
#   sh stt_switch.sh parakeet    # Parakeet primary, Whisper as fallback (default)
#   sh stt_switch.sh whisper     # Whisper primary, Parakeet as fallback
#   sh stt_switch.sh             # show the current setting
#
# Environment (defaults match the launchd examples in DOCS.md):
#   OPTIONS_FILE   ~/.config/nest_headless/options.json
#   PARAKEET_URL   http://127.0.0.1:8180
#   WHISPER_URL    http://127.0.0.1:8178
#   LAUNCHD_LABEL  com.example.nest-headless   (the add-on's launchd label)
set -e
OPTIONS_FILE="${OPTIONS_FILE:-$HOME/.config/nest_headless/options.json}"
PARAKEET_URL="${PARAKEET_URL:-http://127.0.0.1:8180}"
WHISPER_URL="${WHISPER_URL:-http://127.0.0.1:8178}"
LAUNCHD_LABEL="${LAUNCHD_LABEL:-com.example.nest-headless}"

case "${1:-show}" in
  parakeet) primary="$PARAKEET_URL"; backup="$WHISPER_URL" ;;
  whisper)  primary="$WHISPER_URL";  backup="$PARAKEET_URL" ;;
  show) jq '{stt_url, stt_fallback_url, stt_shadow_url}' "$OPTIONS_FILE"; exit 0 ;;
  *) echo "usage: $0 [parakeet|whisper|show]" >&2; exit 2 ;;
esac

tmp="$OPTIONS_FILE.tmp"
jq --arg p "$primary" --arg b "$backup" '.stt_url = $p | .stt_fallback_url = $b | .stt_shadow_url = ""' "$OPTIONS_FILE" > "$tmp" && mv "$tmp" "$OPTIONS_FILE"
echo "stt_url=$primary  stt_fallback_url=$backup"
launchctl kickstart -k "gui/$(id -u)/$LAUNCHD_LABEL" && echo "restarted $LAUNCHD_LABEL"
