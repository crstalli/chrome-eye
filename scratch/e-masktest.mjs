// Reproduce the upstream 1007 in isolation: send a $events open, but with a
// CORRUPTED mask (XOR with a wrong 4-byte key) to see if upstream also 1007s.
import { connect } from 'node:net';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

function b64url(buf) { return Buffer.from(buf).toString('base64').replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''); }
const text = readFileSync('/home/cztl/.dsh/.credentials.yaml','utf8');
const m = text.match(/^\s*secret:\s*(\S+)/m);
const secret = Buffer.from(m[1].replaceAll('-','+').replaceAll('_','/'), 'base64');
const AUTH = '127.0.0.1:3080';
const name = 'dsh-auth-' + b64url(createHash('sha256').update(AUTH).digest());
const body = b64url(JSON.stringify({version:1,authority:AUTH,issuedAt:Date.now(),expiresAt:Date.now()+30*86400e3}));
const sig = b64url(createHmac('sha256', secret).update(body).digest());

const key = Buffer.from(randomUUID().replace(/-/g,'')).slice(0,16).toString('base64');
const sock = connect(3080, '127.0.0.1', () => {
  sock.write(['GET /api/remote.mux HTTP/1.1', `Host: ${AUTH}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', `Cookie: ${name}=v1.${body}.${sig}`, '',''].join('\r\n'));
});
let upgraded = false;
let buf = Buffer.alloc(0);
const CORRUPT = false; // set true to test with wrong mask
function sendText(s, corrupt) {
  const p = Buffer.from(s, 'utf8');
  const mask = Buffer.from(randomUUID().replace(/-/g,'').slice(0,8), 'hex');
  const wrongKey = Buffer.from('deadbeef','hex');
  let h;
  if (p.length < 126) { h = Buffer.from([0x81, 0x80 | p.length]); }
  else { h = Buffer.alloc(6); h[0]=0x81; h[1]=0x80|126; h.writeUInt16BE(p.length,2); }
  const masked = Buffer.alloc(p.length);
  const k = corrupt ? wrongKey : mask;
  for (let i = 0; i < p.length; i++) masked[i] = p[i] ^ k[i % 4];
  sock.write(Buffer.concat([h, mask, masked]));
}
function onFrame(data) {
  buf = Buffer.concat([buf, data]);
  while (true) {
    if (buf.length < 2) break;
    const op = buf[0] & 0x0f;
    let len = buf[1] & 0x7f, off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (buf.length < off + len) break;
    const payload = buf.slice(off, off + len); buf = buf.slice(off + len);
    if (op === 0x1) console.log('SERVER TEXT:', payload.toString('utf8').slice(0, 200));
    else if (op === 0x8) { console.log('SERVER CLOSE code=', payload.length >= 2 ? payload.readUInt16BE(0) : 1005, 'reason=', payload.slice(2).toString('utf8')); process.exit(0); }
    else if (op === 0x9) console.log('SERVER PING');
  }
}
sock.on('data', (c) => {
  if (!upgraded) {
    buf = Buffer.concat([buf, c]);
    const idx = buf.indexOf('\r\n\r\n');
    if (idx === -1) return;
    console.log('HEAD:', buf.slice(0, idx).toString('latin1').split('\r\n')[0]);
    buf = buf.slice(idx + 4);
    upgraded = true;
    sock.on('data', onFrame);
    onFrame(Buffer.alloc(0));
    const msg = JSON.stringify({ type: 'open', streamId: 'smoke-1', endpoint: '$events', payload: { args: {} } });
    sendText(msg, CORRUPT);
    console.log('sent open, corrupt=', CORRUPT);
    setTimeout(() => { console.log('no close in 3s'); process.exit(0); }, 3000);
  }
});
setTimeout(() => { process.exit(2); }, 8000);
