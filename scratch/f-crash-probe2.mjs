#!/usr/bin/env node
// Crash regression probe: 5 concurrent /plugins/events for 20s, then check bridge.
// AbortSignal.timeout is EXPECTED — we just need the bridge to survive.
const BASE = 'http://127.0.0.1:3081';

async function probe(i) {
  try {
    const r = await fetch(BASE + '/plugins/events', {
      headers: { 'Accept': 'text/event-stream' },
      signal: AbortSignal.timeout(20000),
    });
    // Drain the stream until timeout
    const reader = r.body.getReader();
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
    }
    return { i, status: r.status, bytes, note: 'stream drained' };
  } catch (e) {
    return { i, status: 'err', error: e.name, bytes: 0 };
  }
}

const probers = [];
for (let i = 0; i < 5; i++) probers.push(probe(i));
await Promise.all(probers);

// Check bridge still alive
let alive = false;
try { alive = (await fetch(BASE + '/', { signal: AbortSignal.timeout(3000) })).status === 200; } catch {}

console.log('Bridge alive after 20s concurrent SSE:', alive);
for (const r of probers.sort((a, b) => a.i - b.i)) {
  console.log('  probe ' + r.i + ': status=' + r.status + ' bytes=' + r.bytes + (r.error ? ' err=' + r.error : ''));
}
process.exit(alive ? 0 : 1);
