import { readFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
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
  return { cookie: `${name}=${'v1.' + body + '.' + sig}`, name, sig, body };
}
console.log('cookie name for 3080:', mint('127.0.0.1:3080').name);
function tryUpgrade(label, host, path, cookieOrExtra) {
  return new Promise((resolve) => {
    const key = b64url(randomBytes(16));
    const extra = [];
    if (typeof cookieOrExtra === 'string') extra.push(`Cookie: ${cookieOrExtra}`);
    else if (Array.isArray(cookieOrExtra)) extra.push(...cookieOrExtra);
    const req = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      ...extra,
      '',
      ''
    ].join('\r\n');
    const sock = net.connect(3080, '127.0.0.1');
    const chunks = [];
    const t = setTimeout(() => { sock.destroy(); resolve(`${label}: TIMEOUT (no bytes in 4s)`); }, 4000);
    sock.on('data', (c) => {
      chunks.push(c);
      const buf = Buffer.concat(chunks);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx >= 0) {
        clearTimeout(t);
        sock.destroy();
        resolve(`${label}: ${buf.toString('latin1', 0, idx).split('\r\n').slice(0, 3).join(' | ')}`);
      }
    });
    sock.write(req);
  });
}
const c3080 = mint('127.0.0.1:3080');
const c3081 = mint('127.0.0.1:3081');
// variant: sign with secret + body but include authority in signed content differently?
// try: maybe signature is over name+body or name+authority+body
const v1 = (body, extra) => 'v1.' + body + '.' + b64url(createHmac('sha256', secret).update(extra ?? body).digest());
// G: cookie for 3081 signed over name+body
const sigG = b64url(createHmac('sha256', secret).update(mint('127.0.0.1:3081').name + c3081.body).digest());
const cookieG = `${c3081.name}=v1.${c3081.body}.${sigG}`;
// H: sign over JSON payload directly (raw, not b64url)
const payload = { version: 1, authority: '127.0.0.1:3080', issuedAt: Date.now() };
payload.expiresAt = payload.issuedAt + 30 * 86400000;
const sigH = b64url(createHmac('sha256', secret).update(JSON.stringify(payload)).digest());
const cookieH = `${c3080.name}=v1.${b64url(JSON.stringify(payload))}.${sigH}`;
console.log(await tryUpgrade('G: host=3081 sign(name+body)', '127.0.0.1:3081', '/api/remote.mux', cookieG));
console.log(await tryUpgrade('H: host=3081 sign(rawJSON)   ', '127.0.0.1:3081', '/api/remote.mux', cookieH));
console.log(await tryUpgrade('I: host=3080 sign(rawJSON)   ', '127.0.0.1:3080', '/api/remote.mux', cookieH));
process.exit(0);
