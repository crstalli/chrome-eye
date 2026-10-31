#!/usr/bin/env node
// Diagnostic: replay session/list POST via :3081 AND :3080 (with cookie), compare raw bytes.
import { readFileSync, writeFileSync } from 'node:fs';
const payload = {"type":"client-request","rpcId":"list-test-001","method":"session/list","payload":{"args":{"request":{}}}};
const body = JSON.stringify(payload);
const cookie = readFileSync('/tmp/cookie.txt', 'utf8').trim();

// Via 3081
const r1 = await fetch('http://127.0.0.1:3081/api/session/list', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10000)
});
const b1 = Buffer.from(await r1.arrayBuffer());
writeFileSync('/tmp/list-3081.bin', b1);
console.log('3081: status=' + r1.status, 'bytes=' + b1.length, 'hex=' + b1.subarray(0, 4).toString('hex'));
// Parse the JSON
try {
  const j1 = JSON.parse(b1.toString('utf8'));
  console.log('  type:', j1.type, 'method:', j1.method);
  if (j1.payload && j1.payload.result) {
    const res = j1.payload.result;
    console.log('  result keys:', Object.keys(res).join(','));
    if (res.sessions) console.log('  sessions count:', res.sessions.length, 'first:', res.sessions.slice(0, 3).map(s => s.id?.substring(0, 8) + ':' + s.workspaceId?.substring(0, 8)));
  }
} catch (e) { console.log('  parse failed:', e.message); }

// Via 3080 with cookie
const r2 = await fetch('http://127.0.0.1:3080/api/session/list', {
  method: 'POST', headers: { 'content-type': 'application/json', 'cookie': cookie }, body, signal: AbortSignal.timeout(10000)
});
const b2 = Buffer.from(await r2.arrayBuffer());
writeFileSync('/tmp/list-3080.bin', b2);
console.log('3080: status=' + r2.status, 'bytes=' + b2.length, 'hex=' + b2.subarray(0, 4).toString('hex'));
try {
  const j2 = JSON.parse(b2.toString('utf8'));
  console.log('  type:', j2.type, 'method:', j2.method);
  if (j2.payload && j2.payload.result) {
    const res = j2.payload.result;
    console.log('  result keys:', Object.keys(res).join(','));
    if (res.sessions) console.log('  sessions count:', res.sessions.length, 'first:', res.sessions.slice(0, 3).map(s => s.id?.substring(0, 8) + ':' + s.workspaceId?.substring(0, 8)));
  }
} catch (e) { console.log('  parse failed:', e.message); }

// Compare
console.log('SAME:', Buffer.compare(b1, b2) === 0);
process.exit(0);
