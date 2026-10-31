import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const text = readFileSync('/home/cztl/.dsh/.credentials.yaml', 'utf8');
const m = text.match(/secret:\s*(\S+)/);
const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
const b64url = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const { createHash, createHmac } = await import('node:crypto');
function mint(authority) {
  const name = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest());
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 30 * 86400000;
  const body = b64url(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${name}=${'v1.' + body + '.' + sig}`;
}
const cookie = mint('127.0.0.1:3080');
// discover real /api endpoints from the GUI HTML
const res = await fetch('http://127.0.0.1:3080/', { headers: { cookie } });
const html = await res.text();
const methods = [...new Set([...html.matchAll(/["']([a-zA-Z][a-zA-Z0-9]+\/[a-zA-Z0-9.\/-]{3,})["']/g)].map(x => x[1]))].filter(s => s.includes('/')).slice(0, 30);
console.log('candidate methods:', methods);
for (const method of ['settings/get', 'pluginInventory/list', 'session.list', 'workspaces/list', 'sessions/list']) {
  const r = await fetch('http://127.0.0.1:3080/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: 'mt', method, payload: { args: {} } }),
  });
  const t = await r.text();
  console.log(method, '->', r.status, t.slice(0, 120).replace(/\n/g, ' '));
}
