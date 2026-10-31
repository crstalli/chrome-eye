#!/usr/bin/env node
// Diagnostic: replay session/list with NO Accept-Encoding via raw http (no auto-decompress) through 3081.
import http from 'node:http';
import { writeFileSync } from 'node:fs';
const payload = {"type":"client-request","rpcId":"noenc-list-001","method":"session/list","payload":{"args":{"_request":{}}}};
const body = JSON.stringify(payload);

const req = http.request({ host: '127.0.0.1', port: 3081, path: '/api/session/list', method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': body.length } },
  (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const buf = Buffer.concat(chunks);
      writeFileSync('/tmp/list-noenc-3081.bin', buf);
      console.log('3081 no-Accept-Encoding: status=' + res.statusCode, 'bytes=' + buf.length);
      console.log('  ce:', res.headers['content-encoding'], 'ct:', res.headers['content-type'], 'vary:', res.headers['vary']);
      console.log('  hex:', buf.subarray(0, 8).toString('hex'));
      if (buf[0] === 0x1f && buf[1] === 0x8b) {
        console.log('  => GZIP! Bridge is delivering compressed bytes.');
      } else {
        console.log('  => PLAIN JSON');
      }
    });
  });
req.on('error', (e) => console.log('error:', e.message));
req.write(body);
req.end();
