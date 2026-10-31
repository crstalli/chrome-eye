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
console.log('script tags:', [...head.matchAll(/<script[^>]*src="([^"]+)"/g)].map(x => x[1]));
const urls = [...head.matchAll(/<script[^>]*src="([^"]+)"/g)].map(x => x[1].replace(/&amp;/g, '&'));
for (const u of urls) {
  const r = await fetch('http://127.0.0.1:3080/' + u.replace(/^\.\//, ''), { headers: { cookie } });
  const js = await r.text();
  const hits = {
    mux: (js.match(/events\.[a-z]+/g) || []).filter((v, i, a) => a.indexOf(v) === i).slice(0, 8),
    newWS: (js.match(/new WebSocket\([^)]{0,120}/g) || []).slice(0, 6),
    protoHost: (js.match(/(?:location|window\.location)\.(?:host|origin|protocol)/g) || []).filter((v, i, a) => a.indexOf(v) === i).slice(0, 8),
  };
  if (hits.mux.length || hits.newWS.length) {
    console.log('FILE:', u, 'len', js.length);
    for (const k in hits) if (hits[k].length) console.log(' ', k, JSON.stringify(hits[k]));
  }
}
