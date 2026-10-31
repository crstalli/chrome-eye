// Raw-socket WS upgrade to :3080 /api/remote.mux with minted cookie, printing the full response head.
import { connect } from 'node:net';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

function b64url(buf) { return Buffer.from(buf).toString('base64').replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''); }
const text = readFileSync('/home/cztl/.dsh/.credentials.yaml','utf8');
const m = text.match(/^\s*secret:\s*(\S+)/m);
const secret = Buffer.from(m[1].replaceAll('-','+').replaceAll('_','/'), 'base64');
const AUTH = '127.0.0.1:3080';
const name = 'dsh-auth-' + b64url(createHash('sha256').update(AUTH).digest());
const body = b64url(JSON.stringify({version:1,authority:AUTH,issuedAt:Date.now(),expiresAt:Date.now()+30*86400e3}));
const sig = b64url(createHmac('sha256', secret).update(body).digest());

const key = randomBytes(16).toString('base64');
const sock = connect(3080, '127.0.0.1', () => {
  sock.write([
    'GET /api/remote.mux HTTP/1.1',
    `Host: ${AUTH}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    `Cookie: ${name}=v1.${body}.${sig}`,
    '', ''
  ].join('\r\n'));
});
let buf = Buffer.alloc(0);
const timer = setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 6000);
sock.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  const idx = buf.indexOf('\r\n\r\n');
  if (idx !== -1) {
    clearTimeout(timer);
    console.log('--- response head ---');
    console.log(buf.slice(0, idx).toString('latin1'));
    console.log('--- end (rest bytes:', buf.length - idx - 4, ') ---');
    sock.destroy();
    process.exit(0);
  }
});
sock.on('error', (e) => { console.log('sock error', e.message); process.exit(1); });
