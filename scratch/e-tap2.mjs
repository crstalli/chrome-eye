// Tap the UPSTREAM connection of the real bridge.mjs. The bridge listens on
// 3081; we cannot tap its internal sockets, so instead we run a SECOND
// identical minimal proxy (like e-bridge-tap) but log the EXACT upstream
// request lines AND the exact masked frame sent — then compare with what
// e-masktest.mjs (which WORKS) sends.
// Actually simpler: just run e-bridge-tap's pump inline against 3080 and
// print the hex of the frame we send, then manually compare with e-masktest's
// frame. But we already have both. The real question: what does the BRIDGE
// send? We can't tap its internal sockets. So instead, let's reproduce the
// bridge's exact maskFrame+wsFrame code and check if the output is valid.
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

// The bridge's wsFrame (server->client, unmasked)
function wsFrame(opcode, payload, fin = true) {
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = (fin ? 0x80 : 0) | opcode;
  return Buffer.concat([header, payload]);
}
// The bridge's maskFrame
function maskFrame(frame) {
  if (!frame.length || (frame[1] & 0x80) !== 0) return frame;
  const mask = Buffer.from(randomUUID().replace(/-/g, '').slice(0, 8), 'hex');
  const header = Buffer.from(frame);
  header[1] |= 0x80;
  const masked = Buffer.alloc(frame.length - 2);
  for (let i = 0; i < masked.length; i++) masked[i] = frame[2 + i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

const msg = Buffer.from(JSON.stringify({ type: 'open', streamId: 'smoke-1', endpoint: '$events', payload: { args: {} } }), 'utf8');
console.log('payload len:', msg.length);
const raw = wsFrame(0x1, msg);
console.log('raw wsFrame hex:', raw.toString('hex'));
console.log('raw b0:', raw[0].toString(16), 'b1:', raw[1].toString(16));
const masked = maskFrame(raw);
console.log('masked hex:', masked.toString('hex'));
console.log('masked b0:', masked[0].toString(16), 'b1:', masked[1].toString(16));

// Now verify: unmask the masked frame and check it matches
const maskKey = masked.slice(2, 6);
const maskedPayload = masked.slice(6);
console.log('maskKey:', maskKey.toString('hex'), 'len:', maskKey.length);
const unmasked = Buffer.alloc(maskedPayload.length);
for (let i = 0; i < maskedPayload.length; i++) unmasked[i] = maskedPayload[i] ^ maskKey[i % 4];
console.log('unmasked payload:', unmasked.toString('utf8'));
console.log('matches original:', unmasked.equals(msg));

// Send through a real connection to 3080
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
    sock.write(masked);
    console.log('sent masked frame, hex:', masked.toString('hex').slice(0, 80));
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
