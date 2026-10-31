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
const urls = [...head.matchAll(/<script[^>]*src="([^"]+)"/g)].map(x => x[1].replace(/&amp;/g, '&'));
const vendorUrl = './assets/vendor-CCJJTK99.js';
const r = await fetch('http://127.0.0.1:3080/' + vendorUrl, { headers: { cookie } });
const js = await r.text();
console.log('vendor len:', js.length);
const pats = [
  ['mux', /mux/g],
  ['newWS', /new WebSocket\([^)]{0,150}/g],
  ['wsurl', /["'`][^"'`]*wss?:[^"'`]{0,60}["'`]/g],
  ['api', /["'`]\/api\/[^"'`]{0,50}["'`]/g],
  ['dollar', /\$events/g],
];
for (const [name, p] of pats) {
  const hits = [...new Set(js.match(p) || [])].slice(0, 15);
  if (hits.length) console.log(name, '=>', hits);
}
