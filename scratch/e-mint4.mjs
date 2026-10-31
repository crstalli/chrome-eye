import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { connect } from 'node:net';
const text = readFileSync('/home/cztl/.dsh/.credentials.yaml', 'utf8');
const m = text.match(/secret:\s*(\S+)/);
const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
const b64url = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
function mint(authority) {
  const name = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest());
  const issuedAt = Date.now();
  const body = b64url(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + 30 * 86400000 }));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${name}=${'v1.' + body + '.' + sig}`;
}
const cookie = mint('127.0.0.1:3080');
const key = b64url('0123456789abcdef');
const sock = connect(3080, '127.0.0.1', () => {
  sock.write(
    `GET /api/events.mux HTTP/1.1\r\n` +
    `Host: 127.0.0.1:3081\r\n` +
    `Upgrade: websocket\r\n` +
    `Connection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\n` +
    `Sec-WebSocket-Version: 13\r\n` +
    `Cookie: ${cookie}\r\n` +
    `\r\n`
  );
});
let buf = '';
sock.on('data', (d) => { buf += d.toString(); if (buf.includes('\r\n\r\n')) { console.log('WS upgrade status line:', buf.split('\r\n')[0]); console.log('set-cookie present:', buf.toLowerCase().includes('set-cookie')); sock.destroy(); } });
setTimeout(() => { console.log('timeout; got:', buf.split('\r\n')[0] ?? '(nothing)'); process.exit(0); }, 3000);
