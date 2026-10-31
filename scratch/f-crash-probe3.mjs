#!/usr/bin/env node
// Crash regression probe v3: 5 concurrent SSE, 25s, proper result tracking.
const BASE = 'http://127.0.0.1:3081';
const results = [];

async function probe(i) {
  try {
    const r = await fetch(BASE + '/plugins/events', {
      headers: { 'Accept': 'text/event-stream' },
      signal: AbortSignal.timeout(25000),
    });
    const reader = r.body.getReader();
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
    }
    results.push({ i, status: r.status, bytes });
  } catch (e) {
    results.push({ i, status: 'timeout-expected', bytes: 0, err: e.name });
  }
}

const ps = [];
for (let i = 0; i < 5; i++) ps.push(probe(i));
await Promise.all(ps);

let alive = false;
try { alive = (await fetch(BASE + '/', { signal: AbortSignal.timeout(3000) })).status === 200; } catch {}

console.log('Bridge alive after 25s x5 concurrent SSE:', alive);
for (const r of results.sort((a, b) => a.i - b.i)) {
  console.log('  probe ' + r.i + ': status=' + r.status + ' bytes=' + r.bytes);
}
process.exit(alive ? 0 : 1);
