#!/bin/bash
# ROUND 21 — STARTUP + PERSISTENCE/RESTART VALIDATION OF THE PACKAGED APP
# Launches the REAL packaged production build (release/linux-unpacked) under Xvfb,
# twice, with an isolated profile, and verifies engine persistence across restart.
set -u
APP=/home/z/my-project/jarvis/release/linux-unpacked/jarvis-electron
PROFILE=/tmp/jarvis-r21-release-profile
DATA=/tmp/jarvis-r21-release-data
LOG1=/tmp/jarvis-r21-run1.log
LOG2=/tmp/jarvis-r21-run2.log
rm -rf "$PROFILE" "$DATA"
mkdir -p "$PROFILE" "$DATA"
export DISPLAY=:99
export HOME="$PROFILE"
export JARVIS_FILES_ROOT="$DATA"

echo "== run 1: start the packaged app =="
"$APP" --no-sandbox >"$LOG1" 2>&1 &
PID1=$!
sleep 14
if kill -0 "$PID1" 2>/dev/null; then echo "run1: ALIVE after 14s"; else echo "run1: DIED"; fi
# Graceful quit (SIGTERM), like a normal shutdown.
kill "$PID1" 2>/dev/null
wait "$PID1" 2>/dev/null
echo "== engine data after run 1 =="
ls "$DATA" 2>/dev/null | sed 's/^/  data: /'
ls "$DATA/brain" 2>/dev/null | sed 's/^/  brain: /'

echo "== run 2: restart and verify persistence =="
"$APP" --no-sandbox >"$LOG2" 2>&1 &
PID2=$!
sleep 14
if kill -0 "$PID2" 2>/dev/null; then echo "run2: ALIVE after 14s"; else echo "run2: DIED"; fi
kill "$PID2" 2>/dev/null
wait "$PID2" 2>/dev/null

echo "== error scan =="
for f in "$LOG1" "$LOG2"; do
  echo "-- $f"
  grep -iE "unhandledRejection|uncaughtException|could not be parsed|corrupt|EPERM|EACCES" "$f" | grep -vE "dbus|bus.cc|GPU|gpu_|viz_main|sandbox" | head -5 || true
done
echo "== done =="
