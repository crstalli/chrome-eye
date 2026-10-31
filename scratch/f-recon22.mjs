#!/usr/bin/env node
// Diagnostic: replay session/create via :3081 WITHOUT Accept-Encoding, dump raw bytes.
import { writeFileSync } from 'node:fs';
const payload = {"type":"client-request","rpcId":"noenc-test-001","method":"session/create","payload":{"args":{"request":{"workspaceId":"87e4d4a4-1d5e-4b5e-bc72-3eab2a2bab87"}}}};
const body = JSON.stringify(payload);
const r1 = await fetch('http://127.0.0.1:3081/api/session/create', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body, signal: AbortSignal.timeout(10000)
});
const b1 = Buffer.from(await r1.arrayBuffer());
writeFileSync('/tmp/noenc-3081.bin', b1);
console.log('3081 no-Accept-Encoding: status=' + r1.status, 'bytes=' + b1.length);
console.log('  hex:', b1.subarray(0, 16).toString('hex'));
console.log('  ct:', r1.headers.get('content-type'), 'ce:', r1.headers.get('content-encoding'), 'vary:', r1.headers.get('vary'));
console.log('  text:', JSON.stringify(b1.subarray(0, 120).toString('utf8')));
process.exit(0);
