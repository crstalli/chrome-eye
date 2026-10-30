#!/usr/bin/env node
/**
 * WS smoke test for the bridge (used by test.sh): connects to
 * ws://127.0.0.1:<port>/api/remote.mux and proves the full pipe works:
 *
 *   1. 101 upgrade handshake succeeds (bridge's RFC6455 server side).
 *   2. A valid client text frame (a mux "open" for the $events stream) is
 *      parsed by the bridge (masked client frames) and forwarded upstream —
 *      the live host answers with a {"type":"item",...,"value":{"type":"ready"}}
 *      frame ONLY if it received a well-formed stream open, so receiving it
 *      proves the frame really made it upstream through the bridge.
 *   3. The bridge then closes the socket with 1000 on our side.
 *
 * Exits 0 and prints "ws-smoke: ok" on success; non-zero otherwise.
 */
const port = process.argv[2] || '3081';
const url = `ws://127.0.0.1:${port}/api/remote.mux`;

const ws = new WebSocket(url);
let opened = false;
let gotReady = false;
const fail = (why) => {
  console.error(`ws-smoke: FAIL: ${why}`);
  try {
    ws.close();
  } catch {}
  process.exit(1);
};

const overall = setTimeout(() => fail('overall timeout (10s)'), 10000);

ws.addEventListener('error', (ev) => {
  console.error('ws-smoke: error event', ev?.message ?? 'unknown');
});

ws.addEventListener('message', (ev) => {
  // The upstream host answers a valid $events open with a ready item.
  let text = '';
  try { text = typeof ev.data === 'string' ? ev.data : ''; } catch {}
  if (!text) return;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return; }
  if (parsed && parsed.type === 'item' && parsed.value && parsed.value.type === 'ready') {
    console.log('ws-smoke: ok (upgrade + frame round-trip)');
    gotReady = true;
    clearTimeout(overall);
    setTimeout(() => process.exit(0), 50);
  } else if (parsed && parsed.type === 'error') {
    fail(`upstream stream error: ${JSON.stringify(parsed.error ?? {})}`);
  }
});

ws.addEventListener('open', () => {
  opened = true;
  console.log('ws-smoke: open (101 upgrade ok)');
  // A well-formed mux stream open: the host replies with a ready item,
  // proving the masked client frame crossed the bridge to upstream.
  ws.send(JSON.stringify({ type: 'open', streamId: 'smoke-1', endpoint: '$events', payload: { args: {} } }));
});

ws.addEventListener('close', (ev) => {
  clearTimeout(overall);
  if (gotReady) return; // already exited in the message handler
  if (!opened) {
    fail(`closed before open: code=${ev.code} reason=${JSON.stringify(ev.reason)}`);
    return;
  }
  if (ev.code === 1000) {
    console.log(`ws-smoke: ok (upgrade + frame round-trip, close code=${ev.code})`);
    setTimeout(() => process.exit(0), 50);
  } else {
    fail(`unexpected close: code=${ev.code} reason=${JSON.stringify(ev.reason)}`);
  }
});
