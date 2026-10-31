#!/usr/bin/env node
// Diagnostic: raw http.request (no auto-decompress) via 3081 and 3080, compare bytes.
import http from 'node:http';
import { writeFileSync } from 'node:fs';
const payload = {"type":"client-request","rpcId":"rawhttp-test","method":"session/create","payload":{"args":{"request":{"workspaceId":"87e4d4a4-1d5e-4b5e-bc72-3eab2a2bab87"}}}};
const body = JSON.stringify(payload);

function rawReq(host, port, label, extraHeaders) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const req = http.request({ host, port, path: '/api/session/create', method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json', 'content-length': body.length }, extraHeaders) },
      (res) => {
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          writeFileSync('/tmp/rawhttp-' + label + '.bin', buf);
          console.log(label + ': status=' + res.statusCode, 'bytes=' + buf.length);
          console.log('  ce:', res.headers['content-encoding'], 'ct:', res.headers['content-type']);
          console.log('  hex:', buf.subarray(0, 16).toString('hex'));
          resolve();
        });
      });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

await rawReq('127.0.0.1', 3081, '3081-default', {});
await rawReq('127.0.0.1', 3081, '3081-identity', { 'accept-encoding': 'identity' });
await rawReq('127.0.0.1', 3080, '3080-default', { cookie: (await import('node:fs')).readFileSync('/tmp/cookie.txt','utf8').trim() });
process.exit(0);
