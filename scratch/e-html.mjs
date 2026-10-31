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
const r = await fetch('http://127.0.0.1:3080/', { headers: { cookie: mint('127.0.0.1:3080') } });
const html = await r.text();
console.log('status:', r.status, 'len:', html.length);
// absolute :3080 references?
console.log('has 127.0.0.1:3080:', html.includes('127.0.0.1:3080'));
console.log('has localhost:3080:', html.includes('localhost:3080'));
// which asset URLs
const urls = [...new Set([...html.matchAll(/(src|href)="([^"]+)"/g)].map(x => x[2]))];
console.log('asset urls:', urls);
const wsRefs = [...html.matchAll(/ws[s]?:\/\/[^\s"'<>]+/g)].map(x => x[0]);
console.log('ws refs:', [...new Set(wsRefs)]);
console.log('head:', html.slice(0, 300).replace(/\n/g, ' '));
