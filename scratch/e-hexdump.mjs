// Hexdump the first bytes the client receives after the 101 through the bridge.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';

const child = spawn('node', ['bridge/bridge.mjs'], {
  cwd: '/mnt/f/ai/chrome-eye',
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (c) => { process.stdout.write('[bridge] ' + c); });
child.stderr.on('data', (c) => { process.stdout.write('[bridge!] ' + c); });
let log = '';
child.stdout.on('data', (c) => { log += c; });

for (let i = 0; i < 50; i++) { if (log.includes('listening')) break; await sleep(100); }

// Build a valid $events open, masked, exactly as a real WS client sends.
const msg = Buffer.from(JSON.stringify({ type: 'open', streamId: 'smoke-1', endpoint: '$events', payload: { args: {} } }), 'utf8');
const mask = Buffer.from(randomUUID().replace(/-/g, '').slice(0, 8), 'hex');
const header = Buffer.from([0x81, 0x80 | msg.length]);
const masked = Buffer.alloc(msg.length);
for (let i = 0; i < msg.length; i++) masked[i] = msg[i] ^ mask[i % 4];

const key = randomUUID().replace(/-/g, '').slice(0, 16); // 16 chars
const sock = connect(3081, '127.0.0.1', () => {
  sock.write(['GET /api/remote.mux HTTP/1.1', 'Host: 127.0.0.1:3081', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${Buffer.from(key).toString('base64')}`, 'Sec-WebSocket-Version: 13', '', ''].join('\r\n'));
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
    sock.write(Buffer.concat([header, mask, masked]));
    console.log('SENT open, len', msg.length);
    setTimeout(() => { console.log('--- waiting for response ---'); }, 100);
  } else {
    console.log('FRAME BYTES:', buf.toString('hex'));
    const op = buf[0] & 0x0f;
    let len = buf[1] & 0x7f, off = 2;
    if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { len = Number(buf.readBigUInt64BE(2)); off = 10; }
    if (buf.length >= off + len) {
      console.log('opcode:', op, 'len:', len);
      if (op === 0x1) console.log('TEXT:', buf.slice(off, off + len).toString('utf8').slice(0, 300));
      if (op === 0x8) console.log('CLOSE code:', buf.readUInt16BE(off), 'reason:', buf.slice(off + 2).toString('utf8'));
    }
    child.kill();
    process.exit(0);
  }
});
setTimeout(() => { child.kill(); process.exit(3); }, 8000);
