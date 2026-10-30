#!/usr/bin/env bash
# chrome-eye bridge test — deps: bash, curl, node (v24+), nothing else.
#
# Starts bridge.mjs on 127.0.0.1:3081 (forwards to the DSH GUI on :3080) and
# verifies:
#   1. GET  /health            -> {"ok":true}
#   2. POST /api/pluginInventory/list with a hostile Origin header ->
#      server-response, rpcId "t1" echoed, ok:true (Origin stripped by bridge)
#   3. POST /share (no sessionId) -> ok:true + captures/<unix-seconds>.json exists
#   3c. CORS (CP-6): OPTIONS preflight for /share and /api/* -> 204 with
#      Access-Control-Allow-Origin / Allow-Content-Type headers, plus ACAO
#      present on /health, /share and /api/* actual responses
#   4. WS   /api/remote.mux upgrade + frame round-trip (added beyond the 3 spec steps)
#
# Exit 0 only if every check passes.

set -u
cd "$(dirname "$0")"

PORT=3081
LOG=bridge.test.log
PASS=0
FAIL=0
FAILURES=()

note() { printf '%s\n' "$*"; }

check() { # $1 = name, rest = command to run
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    note "PASS: $name"
    PASS=$((PASS + 1))
  else
    note "FAIL: $name"
    FAILURES+=("$name")
    FAIL=$((FAIL + 1))
  fi
}

# --- start bridge -----------------------------------------------------------
note "[setup] starting bridge on :$PORT (log: $LOG)"
node bridge.mjs > "$LOG" 2>&1 &
BRIDGE_PID=$!
trap 'kill "$BRIDGE_PID" 2>/dev/null || true' EXIT

ok=0
for _ in $(seq 1 100); do # up to ~10 s
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then ok=1; break; fi
  kill -0 "$BRIDGE_PID" 2>/dev/null || break
  sleep 0.1
done
if [ "$ok" -ne 1 ]; then
  note "FATAL: bridge did not come up; log follows:"
  cat "$LOG"
  exit 1
fi
note "[setup] bridge is up"

# --- 1. /health --------------------------------------------------------------
body=$(curl -s "http://127.0.0.1:$PORT/health")
note "  /health -> $body"
check "1. GET /health -> {\"ok\":true}" test "$body" = '{"ok":true}'

# --- 2. /api forward strips hostile Origin -----------------------------------
# NOTE (deviation from the task's literal body, as permitted): the spec draft
# used method "list" and payload {}. The live contract (dsh-host-apiproxy
# rpc-map + dsh-api-gateway, verified against :3080) requires the method field
# to equal the full endpoint string and remote endpoints to take payload
# {"args": <one object>}. The corrected body is used here; the uncorrected one
# is rejected by :3080 with "bad-request: method does not match endpoint".
body=$(curl -s -X POST "http://127.0.0.1:$PORT/api/pluginInventory/list" \
  -H 'Content-Type: application/json' \
  -H 'Origin: http://evil.example' \
  -d '{"type":"client-request","rpcId":"t1","method":"pluginInventory/list","payload":{"args":{}}}')
note "  /api body (first 240): ${body:0:240}"
check "2a. response is a server-response" grep -q '"server-response"' <<<"$body"
check "2b. rpcId t1 echoed" grep -q '"rpcId":"t1"' <<<"$body"
check "2c. ok:true despite hostile Origin" grep -q '"ok":true' <<<"$body"

# --- 3. /share fallback -------------------------------------------------------
body=$(curl -s -X POST "http://127.0.0.1:$PORT/share" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com","title":"Example","visibleText":"hello world","links":["https://example.com/a"],"headings":["Example Domain"]}')
note "  /share -> $body"
check "3a. share ok:true" grep -q '"ok":true' <<<"$body"
cap_path=$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).path||"")}catch{}})' <<<"$body")
note "  capture path: $cap_path"
check "3b. capture file exists ($cap_path)" test -f "$cap_path"

# --- 3c. CORS (CP-6): preflight + ACAO headers -------------------------------
# The MV3 service worker POSTs cross-origin to :3081 (host_permissions do not
# cover it), so the browser sends an OPTIONS preflight first.
pre=$(curl -s -i -X OPTIONS "http://127.0.0.1:$PORT/share" \
  -H 'Origin: chrome-extension://abc' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type')
check "3c. preflight /share -> 204" grep -qi '^HTTP/1\.1 204' <<<"$pre"
check "3d. preflight /share -> Access-Control-Allow-Origin: *" grep -qi 'access-control-allow-origin: \*' <<<"$pre"
check "3e. preflight /share -> Access-Control-Allow-Content-Type: application/json" grep -qi 'access-control-allow-content-type: application/json' <<<"$pre"

pre2=$(curl -s -i -X OPTIONS "http://127.0.0.1:$PORT/api/session.prompt" \
  -H 'Origin: chrome-extension://abc' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type')
check "3f. preflight /api/* -> 204" grep -qi '^HTTP/1\.1 204' <<<"$pre2"
check "3g. preflight /api/* -> Access-Control-Allow-Origin: *" grep -qi 'access-control-allow-origin: \*' <<<"$pre2"

# Actual responses must carry ACAO too (CP-6 items 1 and 3).
share_full=$(curl -s -i -X POST "http://127.0.0.1:$PORT/share" \
  -H 'Content-Type: application/json' \
  -H 'Origin: chrome-extension://abc' \
  -d '{"url":"https://cors-check.example","title":"cors","visibleText":"","links":[],"headings":[]}')
check "3h. /share response carries ACAO *" grep -qi 'access-control-allow-origin: \*' <<<"$share_full"
check "3i. /share with extension Origin still ok:true" grep -q '"ok":true' <<<"$(tail -n1 <<<"$share_full")"

health_full=$(curl -s -i "http://127.0.0.1:$PORT/health")
check "3j. /health response carries ACAO *" grep -qi 'access-control-allow-origin: \*' <<<"$health_full"

api_full=$(curl -s -i -X POST "http://127.0.0.1:$PORT/api/pluginInventory/list" \
  -H 'Content-Type: application/json' \
  -d '{"type":"client-request","rpcId":"t2","method":"pluginInventory/list","payload":{"args":{}}}')
check "3k. /api/* response carries ACAO *" grep -qi 'access-control-allow-origin: \*' <<<"$api_full"

# --- 4. WS upgrade + frame round-trip (beyond spec; core bridge feature) ------
ws_out=$(node ws-smoke.mjs "$PORT" 2>&1)
note "  ws-smoke: $ws_out"
check "4. WS /api/remote.mux upgrade + frame round-trip" grep -q 'ws-smoke: ok' <<<"$ws_out"

# --- stop bridge --------------------------------------------------------------
kill "$BRIDGE_PID" 2>/dev/null || true
wait "$BRIDGE_PID" 2>/dev/null || true
trap - EXIT

if [ "$FAIL" -eq 0 ]; then
  note "ALL PASS ($PASS checks)"
  exit 0
fi
note "FAILURES (${FAIL}): ${FAILURES[*]}"
note "--- bridge log ---"
cat "$LOG"
exit 1
