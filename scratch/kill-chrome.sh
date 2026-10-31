#!/usr/bin/env bash
# Kill the test Chrome started by launch-chrome.sh (PID-file based, no pattern matching).
set -u
ROOT=/mnt/f/ai/chrome-eye
if [[ -f "$ROOT/scratch/chrome.pid" ]]; then
  PID=$(cat "$ROOT/scratch/chrome.pid")
  kill "$PID" 2>/dev/null
  # kill any children (renderers etc.)
  pkill -P "$PID" 2>/dev/null
fi
sleep 1
exit 0
