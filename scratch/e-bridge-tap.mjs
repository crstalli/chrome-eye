// A minimal WS proxy that TAPS (prints) both directions byte-for-byte.
// If upstream 1007s here too with a correctly-masked frame, the problem is in
// the frame itself; if it returns a ready item, the problem is in bridge.mjs.
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const UP_HOST = '127.0.0.1', UP_PORT = 3080;

function b64url(buf) { return Buffer.from(buf).toString('base64').replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''); }
import { readFileSync } from 'node:fs';
const text = readFileSync('/home/cztl/.dsh/.credentials.yaml','utf8');
const m = text.match(/^\s*secret:\s*(\S+)/m);
const secret = Buffer.from(m[1].replaceAll('-','+').replaceAll('_','/'), 'base64');
const AUTH = '127.0.0.1:3080';
const name = 'dsh-auth-' + b64url(createHash('sha256').update(AUTH).digest());
const body = b64url(JSON.stringify({version:1,authority:AUTH,issuedAt:Date.now(),expiresAt:Date.now()+30*86400e3}));
const sig = b64url(createHmac('sha256', secret).update(body).digest());
const cookie = `${name}=v1.${body}.${sig}`;

function wsFrame(opcode, payload, fin = true) {
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = (fin ? 0x80 : 0) | opcode;
  return Buffer.concat([header, payload]);
}
function maskFrame(frame) {
  if (!frame.length || (frame[1] & 0x80) !== 0) return frame;
  const mask = Buffer.from(randomUUID().replace(/-/g, '').slice(0, 8), 'hex');
  const header = Buffer.from(frame);
  header[1] |= 0x80;
  const masked = Buffer.alloc(frame.length - 2);
  for (let i = 0; i < masked.length; i++) masked[i] = frame[2 + i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}
function readFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  if (len > 1024 * 1024) return null;
  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.slice(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  let payload = buf.slice(offset, offset + len);
  if (masked) {
    const unmasked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) unmasked[i] = payload[i] ^ mask[i % 4];
    payload = unmasked;
  }
  const rest = buf.slice(offset + len);
  return { fin, opcode, payload, rest };
}

const server = createServer();
server.on('upgrade', (req, socket, head) => {
  console.log('client upgrade:', req.url);
  const upstreamKey = Buffer.from(randomUUID().replace(/-/g, '')).slice(0, 16).toString('base64');
  const reqLines = [
    `GET ${req.url} HTTP/1.1`,
    `Host: ${AUTH}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${upstreamKey}`,
    'Sec-WebSocket-Version: 13',
    `Cookie: ${cookie}`,
    '', '',
  ].join('\r\n');
  console.log('UPSTREAM REQ:', JSON.stringify(reqLines));
  const upstream = connect(UP_PORT, UP_HOST);
  let upReady = false;
  upstream.write(reqLines);
  upstream.once('data', (c) => {
    const idx = c.indexOf('\r\n\r\n');
    if (idx === -1) return;
    const headPart = c.slice(0, idx + 4);
    const rest = c.slice(idx + 4);
    const status = headPart.toString('latin1').split('\r\n')[0];
    console.log('UPSTREAM RESP:', status);
    if (!status.includes('101')) { socket.destroy(); upstream.destroy(); return; }
    upReady = true;
    // 101 back to client
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    // pump
    let cbuf = Buffer.alloc(0), ubuf = rest;
    socket.on('data', (chunk) => {
      cbuf = Buffer.concat([cbuf, chunk]);
      console.log('CLIENT BYTES:', chunk.toString('hex'));
      while (true) {
        const f = readFrame(cbuf);
        if (!f) break;
        cbuf = f.rest;
        if (f.opcode === 0x8) { upstream.write(maskFrame(wsFrame(0x8, f.payload))); setTimeout(() => process.exit(0), 200); return; }
        if (f.opcode === 0x9) { upstream.write(maskFrame(wsFrame(0xa, f.payload))); continue; }
        if (f.opcode === 0xa) continue;
        const out = maskFrame(wsFrame(0x1, f.payload));
        console.log('SEND->UP:', out.toString('hex'));
        upstream.write(out);
      }
    });
    upstream.on('data', (chunk) => {
      ubuf = Buffer.concat([ubuf, chunk]);
      console.log('UP BYTES:', chunk.toString('hex'));
      while (true) {
        const f = readFrame(ubuf);
        if (!f) break;
        ubuf = f.rest;
        if (f.opcode === 0x8) { socket.write(wsFrame(0x8, f.payload)); setTimeout(() => process.exit(0), 200); return; }
        if (f.opcode === 0x9) { socket.write(wsFrame(0xa, f.payload)); continue; }
        if (f.opcode === 0xa) continue;
        socket.write(wsFrame(0x1, f.payload));
      }
    });
  });
});
server.listen(3099, '127.0.0.1', async () => {
  console.log('tap listening on 3099');
  // client
  const ws = new WebSocket('ws://127.0.0.1:3099/api/remote.mux');
  ws.addEventListener('message', (ev) => {
    let t = '';
    try { t = typeof ev.data === 'string' ? ev.data : ''; } catch {}
    console.log('CLIENT GOT:', t.slice(0, 200));
    if (t.includes('"ready"')) { setTimeout(() => process.exit(0), 100); }
  });
  ws.addEventListener('open', () => {
    console.log('CLIENT OPEN, sending open');
    ws.send(JSON.stringify({ type: 'open', streamId: 'smoke-1', endpoint: '$events', payload: { args: {} } }));
  });
  ws.addEventListener('close', (ev) => {
    console.log('CLIENT CLOSE', ev.code, ev.reason);
    setTimeout(() => process.exit(ev.code === 1000 ? 0 : 1), 100);
  });
  setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 10000);
});
