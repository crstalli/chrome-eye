#!/usr/bin/env node
// Sustained /plugins/events long-poll crash regression probe.
// Opens multiple concurrent SSE connections and holds them for 15 seconds.
// If the bridge crashes, the connections will drop with errors.
const BASE = 'http://127.0.0.1:3081';
const results = [];

async function probe(i) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + '/plugins/events', {
      headers: { 'Accept': 'text/event-stream' },
      signal: AbortSignal.timeout(15000),
    });
    const status = r.status;
    // Read the stream until timeout
    const reader = r.body.getReader();
    let bytes = 0;
    let lines = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      lines += (value.toString().split('\n').length - 1);
    }
    results.push({ i, ok: true, status, bytes, lines, ms: Date.now() - t0 });
  } catch (e) {
    const isTimeout = e.name === 'TimeoutError' || e.name === 'AbortError';
    results.push({ i, ok: !isTimeout, status: 'err', error: e.name + ': ' + e.message, ms: Date.now() - t0 });
  }
}

// Launch 5 concurrent probes
const probers = [];
for (let i = 0; i < 5; i++) probers.push(probe(i));
await Promise.all(probers);

// Check bridge still alive
let bridgeAlive = false;
try {
  const r = await fetch(BASE + '/', { signal: AbortSignal.timeout(3000) });
  bridgeAlive = r.status === 200;
} catch {}

console.log('Bridge alive after 15s probe:', bridgeAlive);
for (const r of results.sort((a, b) => a.i - b.i)) {
  console.log('  probe ' + r.i + ': ' + (r.ok ? 'OK' : 'FAIL') + ' status=' + r.status + ' bytes=' + (r.bytes||0) + ' lines=' + (r.lines||0) + ' ms=' + r.ms + (r.error ? ' err=' + r.error : ''));
}
process.exit(bridgeAlive ? 0 : 1);
