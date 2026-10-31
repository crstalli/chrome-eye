import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
const text = readFileSync('/home/cztl/.dsh/.credentials.yaml', 'utf8');
const m = text.match(/secret:\s*(\S+)/);
const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
const b64url = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const name = 'dsh-auth-' + b64url(createHash('sha256').update('127.0.0.1:3080').digest());
const issuedAt = Date.now();
const body = b64url(JSON.stringify({ version: 1, authority: '127.0.0.1:3080', issuedAt, expiresAt: issuedAt + 30 * 86400000 }));
const sig = b64url(createHmac('sha256', secret).update(body).digest());
const cookie = `${name}=v1.${body}.${sig}`;
// raw socket upgrade to live 3080 with Host: 127.0.0.1:3081
import net from 'node:net';
const key = b64url(randomBytes(16));
const req = [`GET /api/remote.mux HTTP/1.1`, 'Host: 127.0.0.1:3081', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', `Cookie: ${cookie}`, '', ''].join('\r\n');
const sock = net.connect(3080, '127.0.0.1');
const chunks = [];
const t = setTimeout(() => { sock.destroy(); console.log('TIMEOUT 6s'); process.exit(1); }, 6000);
sock.on('data', (c) => {
  chunks.push(c);
  const buf = Buffer.concat(chunks);
  const idx = buf.indexOf('\r\n\r\n');
  if (idx >= 0) {
    clearTimeout(t);
    const head = buf.toString('latin1', 0, idx);
    console.log(head);
    if (head.includes('101')) {
      console.log('=== 101 SUCCESS — /api/remote.mux upgrades via Host 3081 + cookie(3080) ===');
      sock.destroy(); process.exit(0);
    } else {
      sock.destroy(); process.exit(0);
    }
  }
});
sock.write(req);
