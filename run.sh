#!/usr/bin/env bash
#
# run.sh — (re)start the URL tree review server in the background.
#
#   ./run.sh          stop any previous instance and start a fresh one (detached)
#   ./run.sh stop     just stop the running instance
#   ./run.sh status   show whether it's running + tail the log
#
# It detaches from the terminal (survives closing the tab / logging out), logs to
# logs/server.log, and tracks the process in server.pid. First run creates the
# venv and installs requirements automatically.
#
# Override config via env, e.g.:  PORT=9071 BASE_PATH= ./run.sh
#
set -euo pipefail

# ---- config ----------------------------------------------------------------
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-9070}"
# Use `-` (not `:-`) so an explicit empty BASE_PATH= is honored (no proxy prefix).
BASE_PATH="${BASE_PATH-/webhook5}"
APP="server:app"

# ---- paths (resolve relative to this script, not the caller's cwd) ---------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
VENV="$SCRIPT_DIR/venv"
LOG_DIR="$SCRIPT_DIR/logs"
LOG="$LOG_DIR/server.log"
PIDFILE="$SCRIPT_DIR/server.pid"
mkdir -p "$LOG_DIR"

# ---- stop helper -----------------------------------------------------------
stop() {
  if [ -f "$PIDFILE" ]; then
    OLD="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [ -n "${OLD:-}" ] && kill -0 "$OLD" 2>/dev/null; then
      echo "[stop] terminating previous PID $OLD"
      kill "$OLD" 2>/dev/null || true
      for _ in 1 2 3 4 5; do kill -0 "$OLD" 2>/dev/null || break; sleep 1; done
      kill -9 "$OLD" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi
  # Also free the port in case an untracked/orphaned process is holding it.
  local pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti "tcp:$PORT" 2>/dev/null || true)"
  elif command -v fuser >/dev/null 2>&1; then
    pids="$(fuser "$PORT/tcp" 2>/dev/null || true)"
  fi
  if [ -n "${pids:-}" ]; then
    echo "[stop] freeing port $PORT (PIDs: $pids)"
    kill $pids 2>/dev/null || true
    sleep 1
    kill -9 $pids 2>/dev/null || true
  fi
}

status() {
  if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "[status] running (PID $(cat "$PIDFILE")) on $HOST:$PORT BASE_PATH='$BASE_PATH'"
  else
    echo "[status] not running"
  fi
  [ -f "$LOG" ] && { echo "---- last log lines ----"; tail -n 15 "$LOG"; }
}

case "${1:-}" in
  stop)   stop; echo "[stop] done"; exit 0 ;;
  status) status; exit 0 ;;
esac

# ---- one-time setup: venv + deps ------------------------------------------
if [ ! -x "$VENV/bin/uvicorn" ]; then
  echo "[setup] creating venv and installing requirements ..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q -r "$SCRIPT_DIR/requirements.txt"
fi

# ---- sanity: the (gitignored) data file must be present --------------------
if ! ls "$SCRIPT_DIR"/data/tree-*.js >/dev/null 2>&1; then
  echo "[warn] no data/tree-*.js found — scp the data file into $SCRIPT_DIR/data/ or the tree will not load."
fi

# ---- restart ---------------------------------------------------------------
stop
echo "===== $(date) starting $APP on $HOST:$PORT BASE_PATH='$BASE_PATH' =====" >> "$LOG"
export BASE_PATH
CMD=( "$VENV/bin/uvicorn" "$APP" --host "$HOST" --port "$PORT" --log-level info )

# Detach fully so the server outlives the terminal: setsid (Linux) puts it in a
# new session; nohup (fallback, e.g. macOS) ignores SIGHUP. stdin from /dev/null,
# stdout+stderr appended to the log.
if command -v setsid >/dev/null 2>&1; then
  setsid "${CMD[@]}" >> "$LOG" 2>&1 < /dev/null &
else
  nohup "${CMD[@]}" >> "$LOG" 2>&1 < /dev/null &
fi
NEW_PID=$!
echo "$NEW_PID" > "$PIDFILE"
disown 2>/dev/null || true

# ---- health check ----------------------------------------------------------
sleep 3
if ! kill -0 "$NEW_PID" 2>/dev/null; then
  echo "[error] server exited immediately. Last log lines:"
  tail -n 25 "$LOG"
  exit 1
fi

URL="http://$HOST:$PORT${BASE_PATH}/api/health"
if command -v curl >/dev/null 2>&1 && curl -fsS "$URL" >/dev/null 2>&1; then
  echo "[ok] running (PID $NEW_PID). health: $(curl -fsS "$URL")"
else
  echo "[ok] started (PID $NEW_PID); health at $URL not answered yet — check the log."
fi
echo "[info] log:  $LOG"
echo "[info] stop: ./run.sh stop   (or kill $NEW_PID)"
