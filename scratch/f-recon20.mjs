#!/usr/bin/env node
// Diagnostic: replay session/create EXACTLY via 3081, print full response headers + body.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const payload = {"type":"client-request","rpcId":"replay-test-001","method":"session/create","payload":{"args":{"request":{"workspaceId":"87e4d4a4-1d5e-4b5e-bc72-3eab2a2bab87"}}}};
const res = await fetch('http://127.0.0.1:3081/api/session/create', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(10000)
});
const text = await res.text();
console.log('STATUS:', res.status);
console.log('HEADERS:');
res.headers.forEach((v, k) => console.log('  ' + k + ': ' + v));
console.log('BODY (' + text.length + ' bytes):');
console.log(text.substring(0, 300));
// Now replay via :3080 directly WITHOUT cookie (should be 401)
try {
  const r2 = await fetch('http://127.0.0.1:3080/api/session/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });
  const t2 = await r2.text();
  console.log('\n:3080 direct (no cookie):', r2.status, t2.substring(0, 100));
} catch (e) {
  console.log('\n:3080 direct error:', e.message);
}
process.exit(0);
