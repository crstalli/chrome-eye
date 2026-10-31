#!/usr/bin/env node
// Diagnostic: replay session/create via :3081 AND :3080 (with minted cookie), compare raw bytes.
import { readFileSync } from 'node:fs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const payload = {"type":"client-request","rpcId":"cmp-test-001","method":"session/create","payload":{"args":{"request":{"workspaceId":"87e4d4a4-1d5e-4b5e-bc72-3eab2a2bab87"}}}};
const body = JSON.stringify(payload);

// Via bridge 3081
const r1 = await fetch('http://127.0.0.1:3081/api/session/create', {
  method: 'POST', headers: { 'content-type': 'application/json', 'Accept-Encoding': 'identity' },
  body, signal: AbortSignal.timeout(10000)
});
const b1 = Buffer.from(await r1.arrayBuffer());
console.log('3081: status=' + r1.status, 'bytes=' + b1.length);
console.log('3081 hex:', b1.subarray(0, 16).toString('hex'));
console.log('3081 ct:', r1.headers.get('content-type'), 'ce:', r1.headers.get('content-encoding'));

// Via 3080 with cookie
let cookie = '';
try { cookie = readFileSync('/tmp/cookie.txt', 'utf8').trim(); } catch (e) { console.log('no cookie file'); }
if (cookie) {
  const r2 = await fetch('http://127.0.0.1:3080/api/session/create', {
    method: 'POST', headers: { 'content-type': 'application/json', 'Accept-Encoding': 'identity', 'cookie': cookie },
    body, signal: AbortSignal.timeout(10000)
  });
  const b2 = Buffer.from(await r2.arrayBuffer());
  console.log('3080: status=' + r2.status, 'bytes=' + b2.length);
  console.log('3080 hex:', b2.subarray(0, 16).toString('hex'));
  console.log('3080 ct:', r2.headers.get('content-type'), 'ce:', r2.headers.get('content-encoding'));
}
process.exit(0);
