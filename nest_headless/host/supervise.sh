#!/bin/sh
# Blue/green supervisor for Mac mode (1.18.0). launchd runs this instead of
# run.sh. It keeps one add-on instance alive on the main port and, when a
# deploy is requested, starts the NEW code beside it on a spare port; the new
# instance dials its own camera streams, settles, asks the old one to drain
# (events stop there and start here at the same instant), and takes the main
# port. Sensing never stops; only the HTTP port blinks for a second or two.
#
#   request a deploy:   touch "$STATE_DIR/deploy.request"
#   (edit the code first; the new instance runs whatever is on disk)
#
# Environment (see DOCS.md, Running on a Mac): the same as run.sh, plus
#   STATE_DIR    where deploy.request lives (default: dirname of OPTIONS_FILE, else ~/.config/nest_headless)
#   PORT         main port (default 8098); SPARE_PORT (default PORT+1)
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8098}"
SPARE="${SPARE_PORT:-$((PORT + 1))}"
STATE_DIR="${STATE_DIR:-$(dirname "${OPTIONS_FILE:-$HOME/.config/nest_headless/options.json}")}"
REQ="$STATE_DIR/deploy.request"
log() { echo "[supervise] $(date '+%Y-%m-%dT%H:%M:%S') $*"; }

start_main() { PORT="$PORT" sh "$HERE/run.sh" & CUR=$!; log "started instance pid $CUR on :$PORT"; }
alive() { kill -0 "$1" 2>/dev/null; }

trap 'log "stopping"; [ -n "${NEW:-}" ] && kill "$NEW" 2>/dev/null; kill "$CUR" 2>/dev/null; wait; exit 0' TERM INT

start_main
while :; do
  if [ -f "$REQ" ]; then
    rm -f "$REQ"
    if alive "$CUR"; then
      log "deploy requested: starting new instance on :$SPARE, handing over from :$PORT"
      # expand the old port before PORT is reassigned for the new instance (bash applies
      # assignment words left to right, so a later word would already see the spare port)
      OLD_URL="http://127.0.0.1:$PORT"; OLD_PORT="$PORT"
      PORT="$SPARE" HANDOVER_FROM="$OLD_URL" TARGET_PORT="$OLD_PORT" sh "$HERE/run.sh" & NEW=$!
      # The old instance exits once it has drained. Both halves of that are
      # slower than they look, and on 2026-09-10 four deploys in a row were
      # scored as failures because of it:
      #
      #   handover: proceeding with 1/2 watches live after 212s
      #   handover complete: active on :8098 after 212s
      #   ...supervisor gave up at 240s and killed the instance that had won
      #
      # Two instances share one machine and one Chromium during a handover, so
      # the new one is starved while it settles - event-loop lag hit 123 s on
      # the standby - and 212 s to take the port is normal, not sick. The old
      # one then needs its own time to drain. 240 s covered neither.
      HANDOVER_WAIT="${HANDOVER_WAIT:-480}"
      n=0
      while alive "$CUR" && alive "$NEW" && [ $n -lt "$HANDOVER_WAIT" ]; do sleep 1; n=$((n + 1)); done
      if ! alive "$CUR"; then
        wait "$CUR" 2>/dev/null
        log "handover done after ${n}s: pid $NEW is the instance on :$PORT"
        CUR=$NEW; NEW=
      elif ! alive "$NEW"; then
        wait "$NEW" 2>/dev/null
        log "new instance died before the handover; the old one (pid $CUR) stays"
        NEW=
      else
        log "handover did not complete in ${n}s; killing the new instance, the old one stays"
        kill "$NEW" 2>/dev/null
        k=0; while alive "$NEW" && [ $k -lt 20 ]; do sleep 1; k=$((k + 1)); done
        alive "$NEW" && { log "pid $NEW ignored TERM; sending KILL"; kill -9 "$NEW" 2>/dev/null; }
        wait "$NEW" 2>/dev/null; NEW=
      fi
    else
      log "deploy requested but no instance is running; starting fresh"
      start_main
    fi
    continue
  fi
  if ! alive "$CUR"; then
    wait "$CUR" 2>/dev/null
    log "instance pid $CUR exited; restarting in 5s"
    sleep 5
    start_main
  fi
  sleep 2
done
