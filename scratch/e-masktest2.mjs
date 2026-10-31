// Reproduce e-masktest.mjs CORRUPT=false path EXACTLY against 3080 to confirm
// it works, and compare byte-for-byte with e-tap2's maskFrame output.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';

function b64url(buf) { return Buffer.from(buf).toString('base64').replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''); }
const text = readFileSync('/home/cztl/.dsh/.credentials.yaml','utf8');
const m = text.match(/^\s*secret:\s*(\S+)/m);
const secret = Buffer.from(m[1].replaceAll('-','+').replaceAll('_','/'), 'base64');
const AUTH = '127.0.0.1:3080';
const name = 'dsh-auth-' + b64url(createHash('sha256').update(AUTH).digest());
const body = b64url(JSON.stringify({version:1,authority:AUTH,issuedAt:Date.now(),expiresAt:Date.now()+30*86400e3}));
const sig = b64url(createHmac('sha256', secret).update(body).digest());

// e-masktest CORRUPT=false: manual mask
const msg = Buffer.from(JSON.stringify({ type: 'open', streamId: 'smoke-1', endpoint: '$events', payload: { args: {} } }), 'utf8');
const maskKey = Buffer.from(randomUUID().replace(/-/g,'')).slice(0, 16).toString('base64'); // NO wait, this is the ws key
// Actually e-masktest uses a 4-byte mask key:
const mask4 = Buffer.from(randomUUID().replace(/-/g, '').slice(0, 8), 'hex');
const header = Buffer.alloc(2);
header[0] = 0x81;
header[1] = 0x80 | msg.length;
const maskedPayload = Buffer.alloc(msg.length);
for (let i = 0; i < msg.length; i++) maskedPayload[i] = msg[i] ^ mask4[i % 4];
const frame = Buffer.concat([header, mask4, maskedPayload]);
console.log('e-masktest frame hex:', frame.toString('hex'));
console.log('e-masktest b0:', frame[0].toString(16), 'b1:', frame[1].toString(16));

// Compare with e-tap2's maskFrame output (same input, different mask)
// e-tap2: wsFrame -> 0x81,0x4f,7b22... -> maskFrame -> 0x81,0xcf,<mask>,<xor>
// Both should be valid. Let's send e-masktest's frame and see if it works.
const upstreamKey = Buffer.from(randomUUID().replace(/-/g, '')).slice(0, 16).toString('base64');
const sock = connect(3080, '127.0.0.1', () => {
  sock.write(['GET /api/remote.mux HTTP/1.1', `Host: ${AUTH}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${upstreamKey}`, 'Sec-WebSocket-Version: 13', `Cookie: ${name}=v1.${body}.${sig}`, '',''].join('\r\n'));
});
let upgraded = false;
let buf = Buffer.alloc(0);
sock.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  if (!upgraded) {
    const idx = buf.indexOf('\r\n\r\n');
    if (idx === -1) return;
    console.log('HEAD:', buf.slice(0, idx).toString('latin1').split('\r\n')[0]);
    buf = buf.slice(idx + 4);
    upgraded = true;
    sock.write(frame);
  } else {
    console.log('RESP:', buf.toString('hex'));
    let len = buf[1] & 0x7f, off = 2;
    if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
    const op = buf[0] & 0x0f;
    if (buf.length >= off + len) {
      const payload = buf.slice(off, off + len);
      if (op === 0x1) console.log('TEXT:', payload.toString('utf8').slice(0, 200));
      if (op === 0x8) console.log('CLOSE:', payload.length >= 2 ? payload.readUInt16BE(0) : 1005, payload.slice(2).toString('utf8'));
    }
    process.exit(0);
  }
});
setTimeout(() => process.exit(2), 8000);
