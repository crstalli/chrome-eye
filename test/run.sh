#!/usr/bin/env bash
# Chrome Eye headless test harness orchestrator (local headless Chrome on WSL, no podman).
# Usage: bash /mnt/f/ai/chrome-eye/test/run.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TESTDIR="$ROOT/test"
CHROME_DIR="$TESTDIR/chrome/chrome-linux64"
CHROME_BIN="$CHROME_DIR/chrome"
LIBS_DIR="$TESTDIR/chrome-libs/usr/lib/x86_64-linux-gnu"

SERVER_PORT="${SERVER_PORT:-3456}"
# :9222 is a small CDP HTTP shim (test/cdp-proxy.mjs) that holds the
# /json/new response until the new tab's document has actually swapped from
# about:blank; :9223 is Chrome's real debugging port.
DEBUG_PORT="${DEBUG_PORT:-9222}"
CHROME_DEBUG_PORT="${CHROME_DEBUG_PORT:-9223}"
FIXTURE_URL="http://127.0.0.1:${SERVER_PORT}/page.html"
EXT_DIR="$ROOT/extension"

# Writable scratch (root fs and ~ are read-only on this host).
SCRATCH="${CHROME_EYE_SCRATCH:-$ROOT/test/.chrome-test}"
CONFIG_HOME="$SCRATCH/config"          # CHROME_CONFIG_HOME: crashpad needs a writable DB dir
UDATA="$SCRATCH/udata"                 # --user-data-dir
mkdir -p "$CONFIG_HOME"
rm -rf "$UDATA"; mkdir -p "$UDATA"

export CHROME_CONFIG_HOME="$CONFIG_HOME"
export LD_LIBRARY_PATH="$LIBS_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

SERVER_PID="" CHROME_PID="" PROXY_PID=""
cleanup() {
  [[ -n "$PROXY_PID" ]] && kill "$PROXY_PID" 2>/dev/null
  [[ -n "$CHROME_PID" ]] && kill "$CHROME_PID" 2>/dev/null
  # chrome spawns children (zygote, renderers, crashpad handler) — sweep by pattern.
  # Bracket pattern avoids matching this script's own process.
  pkill -f "chrome-linux64/chrom[e]" 2>/dev/null
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null
  wait 2>/dev/null
  return 0
}
trap cleanup EXIT

if [[ ! -x "$CHROME_BIN" ]]; then
  echo "ERROR: chrome binary not found or not executable: $CHROME_BIN" >&2
  exit 2
fi

echo "== [1/4] fixture server on :$SERVER_PORT"
node "$TESTDIR/server.mjs" --port "$SERVER_PORT" --root "$TESTDIR/fixture" &
SERVER_PID=$!
sleep 0.5

echo "== [2/4] local headless chrome ($("$CHROME_BIN" --version 2>/dev/null))"
"$CHROME_BIN" \
  --headless=new \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --no-first-run \
  --no-default-browser-check \
  --disable-extensions-except="$EXT_DIR" \
  --load-extension="$EXT_DIR" \
  --remote-debugging-port="$CHROME_DEBUG_PORT" \
  --window-size=400,800 \
  --user-data-dir="$UDATA" \
  "$FIXTURE_URL" > "$SCRATCH/chrome.log" 2>&1 &
CHROME_PID=$!

# CDP HTTP shim in front of the debug endpoint: holds PUT /json/new open until
# the new tab's document has swapped away from about:blank, so the harness's
# first readyState poll sees the real panel document (see cdp-proxy.mjs).
node "$TESTDIR/cdp-proxy.mjs" --listen "$DEBUG_PORT" --upstream "$CHROME_DEBUG_PORT" > "$SCRATCH/cdp-proxy.log" 2>&1 &
PROXY_PID=$!

echo "== [3/4] waiting for CDP endpoint on :$DEBUG_PORT"
ok=""
for i in $(seq 1 60); do
  if ! kill -0 "$CHROME_PID" 2>/dev/null; then
    echo "ERROR: chrome exited early; tail of log:" >&2
    tail -20 "$SCRATCH/chrome.log" >&2
    exit 2
  fi
  if curl -s --max-time 2 "http://127.0.0.1:$DEBUG_PORT/json" | grep -q '"type": "page"'; then
    ok="yes"; break
  fi
  sleep 1
done
if [[ -z "$ok" ]]; then
  echo "ERROR: CDP endpoint did not come up within 60s; tail of log:" >&2
  tail -20 "$SCRATCH/chrome.log" >&2
  exit 2
fi

echo "== [4/4] CDP harness"
node "$TESTDIR/harness.mjs" --debug "http://127.0.0.1:$DEBUG_PORT" --fixture-url "$FIXTURE_URL"
rc=$?
echo "== harness exit: $rc"
exit $rc
