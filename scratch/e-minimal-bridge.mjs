// Minimal bridge on 3095: client WS (built-in) -> raw upstream to 3080.
// Uses the EXACT maskFrame logic from bridge.mjs.
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';

function b64url(buf) { return Buffer.from(buf).toString('base64').replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''); }
const text = readFileSync('/home/cztl/.dsh/.credentials.yaml','utf8');
const m = text.match(/^\s*secret:\s*(\S+)/m);
const secret = Buffer.from(m[1].replaceAll('-','+').replaceAll('_','/'), 'base64');
const AUTH = '127.0.0.1:3080';
function mintCookie() {
  const name = 'dsh-auth-' + b64url(createHash('sha256').update(AUTH).digest());
  const body = b64url(JSON.stringify({version:1,authority:AUTH,issuedAt:Date.now(),expiresAt:Date.now()+30*86400e3}));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${name}=v1.${body}.${sig}`;
}
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

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
  const b0 = buf[0];
  const b1 = buf[1];
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
  let mask = null;
  if (masked) {
    if (buf.length < offset + 4) return null;
    mask = buf.slice(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  const payload = Buffer.from(buf.slice(offset, offset + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { fin, opcode, payload, rest: buf.slice(offset + len) };
}

const srv = createServer();
srv.on('upgrade', (req, socket, head) => {
  console.log('upgrade:', req.url);
  const clientKey = req.headers['sec-websocket-key'] || '';
  const upKey = Buffer.from(randomUUID().replace(/-/g, '')).slice(0, 16).toString('base64');
  const upstream = connect(3080, '127.0.0.1', () => {
    upstream.write(['GET /api/remote.mux HTTP/1.1', `Host: ${AUTH}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${upKey}`, 'Sec-WebSocket-Version: 13', `Cookie: ${mintCookie()}`, '',''].join('\r\n'));
  });
  let upBuf = Buffer.alloc(0);
  upstream.on('data', (c) => {
    upBuf = Buffer.concat([upBuf, c]);
    const idx = upBuf.indexOf('\r\n\r\n');
    if (idx === -1) return;
    const head = upBuf.slice(0, idx).toString('latin1');
    const status = head.split('\r\n')[0];
    console.log('upstream:', status);
    upBuf = upBuf.slice(idx + 4);
    if (!status.startsWith('HTTP/1.1 101')) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      return;
    }
    // Send 101 to client
    const accept = createHash('sha1').update(clientKey + WS_GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    // Pump client->upstream
    let cBuf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      cBuf = Buffer.concat([cBuf, chunk]);
      while (true) {
        const frame = readFrame(cBuf);
        if (!frame) break;
        cBuf = frame.rest;
        console.log('client frame:', frame.opcode.toString(16), 'len:', frame.payload.length, frame.payload.toString('utf8').slice(0, 60));
        if (frame.opcode === 0x8) { upstream.destroy(); socket.destroy(); return; }
        if (frame.opcode === 0x9) { upstream.write(wsFrame(0xa, frame.payload)); continue; }
        if (frame.opcode === 0xa) continue;
        const out = maskFrame(wsFrame(0x1, frame.payload));
        console.log('sending to upstream:', out.toString('hex').slice(0, 40));
        upstream.write(out);
      }
    });
    // Pump upstream->client
    const feedUp = (chunk) => {
      while (true) {
        const frame = readFrame(upBuf);
        if (!frame) break;
        upBuf = frame.rest;
        console.log('upstream frame:', frame.opcode.toString(16), 'len:', frame.payload.length, frame.payload.toString('utf8').slice(0, 60));
        if (frame.opcode === 0x8) { socket.write(wsFrame(0x8, frame.payload)); socket.destroy(); upstream.destroy(); return; }
        if (frame.opcode === 0x9) { socket.write(wsFrame(0xa, frame.payload)); continue; }
        if (frame.opcode === 0xa) continue;
        socket.write(wsFrame(0x1, frame.payload));
      }
    };
    if (upBuf.length) feedUp(upBuf);
    upstream.on('data', feedUp);
    socket.resume();
  });
});
srv.listen(3095, '127.0.0.1', () => {
  console.log('listening on 3095');
  // Client: built-in WebSocket
  const ws = new WebSocket('ws://127.0.0.1:3095/api/remote.mux');
  ws.onopen = () => {
    console.log('client open');
    ws.send(JSON.stringify({ type: 'open', streamId: 'smoke-1', endpoint: '$events', payload: { args: {} } }));
  };
  ws.onmessage = (ev) => {
    const d = ev.data;
    console.log('client msg:', d.toString('utf8').slice(0, 120));
    const parsed = JSON.parse(d.toString('utf8'));
    if (parsed.type === 'item' && parsed.value?.type === 'ready') {
      console.log('GOT READY!');
      ws.close(1000, 'done');
    }
  };
  ws.onclose = (ev) => {
    console.log('client close:', ev.code, ev.reason);
    process.exit(ev.code === 1000 ? 0 : 1);
  };
  ws.onerror = (ev) => { console.log('client error:', ev.message || ev); };
  setTimeout(() => process.exit(2), 10000);
});
