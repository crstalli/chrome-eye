#!/usr/bin/env node
// Diagnostic: replay session/list with CORRECT arg format via :3081 AND :3080, compare.
import { readFileSync, writeFileSync } from 'node:fs';
const payload = {"type":"client-request","rpcId":"list-correct-001","method":"session/list","payload":{"args":{"_request":{}}}};
const body = JSON.stringify(payload);
const cookie = readFileSync('/tmp/cookie.txt', 'utf8').trim();

async function test(label, url, headers) {
  const r = await fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body, signal: AbortSignal.timeout(10000) });
  const b = Buffer.from(await r.arrayBuffer());
  writeFileSync('/tmp/list-correct-' + label + '.bin', b);
  console.log(label + ': status=' + r.status, 'bytes=' + b.length, 'hex=' + b.subarray(0, 4).toString('hex'));
  try {
    const j = JSON.parse(b.toString('utf8'));
    if (j.result && j.result.ok) {
      const res = j.result.result || j.result;
      console.log('  ok! keys:', Object.keys(res).join(','));
      if (res.sessions) {
        console.log('  sessions:', res.sessions.length);
        for (const s of res.sessions.slice(0, 5)) {
          console.log('    ' + (s.id||'?').substring(0,8) + ' ws=' + (s.workspaceId||'?').substring(0,8) + ' archived=' + s.archived + ' origin=' + (s.origin||''));
        }
      }
    } else {
      console.log('  error:', JSON.stringify(j.result?.error || j).substring(0, 200));
    }
  } catch (e) { console.log('  parse failed:', e.message.substring(0, 80)); }
}

await test('3081', 'http://127.0.0.1:3081/api/session/list', {});
await test('3080', 'http://127.0.0.1:3080/api/session/list', { cookie });
process.exit(0);
