#!/usr/bin/env bash
# Launch headless Chrome with the Chrome Eye extension on :9222; save PIDs.
set -u
ROOT=/mnt/f/ai/chrome-eye
CHROME_BIN="$ROOT/test/chrome/chrome-linux64/chrome"
export CHROME_CONFIG_HOME="$ROOT/scratch/config"
export LD_LIBRARY_PATH="$ROOT/test/chrome-libs/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
rm -rf "$ROOT/scratch/udata"; mkdir -p "$ROOT/scratch/udata" "$ROOT/scratch/config"
nohup "$CHROME_BIN" --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
  --no-first-run --no-default-browser-check \
  --disable-extensions-except="$ROOT/extension" \
  --load-extension="$ROOT/extension" \
  --remote-debugging-port=9222 --window-size=1280,900 \
  --user-data-dir="$ROOT/scratch/udata" about:blank > "$ROOT/scratch/chrome.log" 2>&1 &
echo $! > "$ROOT/scratch/chrome.pid"
echo "launched pid $(cat "$ROOT/scratch/chrome.pid")"
