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
for (const u of urls) {
  const r = await fetch('http://127.0.0.1:3080/' + u.replace(/^\.\//, ''), { headers: { cookie } });
  const js = await r.text();
  const pats = [/["'`][^"'`]{0,20}mux[^"'`]{0,20}["'`]/g, /["'`]\/api\/[^"'`]{0,40}["'`]/g, /\$events/g, /events\.open|openEvents|remoteEvents/g];
  for (const p of pats) {
    const hits = [...new Set(js.match(p) || [])].slice(0, 15);
    if (hits.length) console.log(u, 'PATTERN', p.source.slice(0, 20), '=>', hits);
  }
  // context around '$events'
  let i = js.indexOf('"$events"');
  if (i === -1) i = js.indexOf('$events');
  while (i !== -1) { console.log('  $events ctx:', js.slice(Math.max(0, i - 200), i + 120).replace(/\n/g, ' ')); i = js.indexOf('$events', i + 7); if (i > 0 && js.slice(i-1, i).includes('"$events"')) break; }
}
