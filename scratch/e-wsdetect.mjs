import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
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
const head = await fetch('http://127.0.0.1:3080/', { headers: { cookie } }).then(r => r.text());
for (const m2 of head.matchAll(/href="([^"]+\.js[^"]*)"/g)) {
  const u = m2[1].replace(/&amp;/g, '&');
  const r = await fetch('http://127.0.0.1:3080/' + u.replace(/^\.\//, ''), { headers: { cookie } });
  const js = await r.text();
  const wsRefs = [...js.matchAll(/[\x22'`]?wss?:\/\/[^\x22'`\s,]+/g)].map(x => x[0]).slice(0, 10);
  const muxRefs = [...js.matchAll(/events\.mux|events\.host|new WebSocket\([^)]{0,80}/g)].map(x => x[0]).slice(0, 10);
  const locRefs = [...js.matchAll(/location\.host|location\.origin|window\.location\.host/g)].map(x => x[0]).slice(0, 5);
  if (wsRefs.length || muxRefs.length) console.log(u.slice(0, 60), '\n  ws:', [...new Set(wsRefs)], '\n  mux:', [...new Set(muxRefs)], '\n  loc:', [...new Set(locRefs)]);
}
