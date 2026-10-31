import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
const text = readFileSync('/home/cztl/.dsh/.credentials.yaml', 'utf8');
const m = text.match(/secret:\s*(\S+)/);
const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
const b64url = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
function mint(authority) {
  const name = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest());
  const issuedAt = Date.now();
  const body = b64url(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + 30 * 86400000 }));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${name}=v1.${body}.${sig}`;
}
function upgrade(label, host, path, cookie) {
  return new Promise((resolve) => {
    const key = b64url(randomBytes(16));
    const req = [`GET ${path} HTTP/1.1`, `Host: ${host}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', `Cookie: ${cookie}`, '', ''].join('\r\n');
    const sock = net.connect(3080, '127.0.0.1');
    const chunks = [];
    const t = setTimeout(() => { sock.destroy(); resolve(`${label}: TIMEOUT 5s`); }, 5000);
    sock.on('data', (c) => {
      chunks.push(c);
      const buf = Buffer.concat(chunks);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx >= 0) {
        clearTimeout(t);
        sock.destroy();
        resolve(`${label}: ${buf.toString('latin1', 0, idx).split('\r\n')[0]}`);
      }
    });
    sock.write(req);
  });
}
const c3080 = mint('127.0.0.1:3080');
const c3081 = mint('127.0.0.1:3081');
console.log(await upgrade('A host=3080 cookie(3080) remote.mux', '127.0.0.1:3080', '/api/remote.mux', c3080));
console.log(await upgrade('B host=3081 cookie(3080) remote.mux', '127.0.0.1:3081', '/api/remote.mux', c3080));
console.log(await upgrade('C host=3081 cookie(3081) remote.mux', '127.0.0.1:3081', '/api/remote.mux', c3081));
process.exit(0);
