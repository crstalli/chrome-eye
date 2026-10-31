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
const r = await fetch('http://127.0.0.1:3080/' + './assets/vendor-CCJJTK99.js', { headers: { cookie } });
const js = await r.text();
// search for 'mux' as a word fragment anywhere
let i = js.indexOf('mux');
let c = 0;
while (i !== -1 && c < 6) {
  console.log('CTX', i, ':', js.slice(Math.max(0, i - 250), i + 150).replace(/\n/g, ' '));
  i = js.indexOf('mux', i + 3); c++;
}
console.log('--- done, total mux hits:', (js.match(/mux/g) || []).length);
