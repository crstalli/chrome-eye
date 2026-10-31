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
const c3081 = mint('127.0.0.1:3081');
// 1. Host header 127.0.0.1:3081 + cookie for 3081
let r = await fetch('http://127.0.0.1:3080/', { headers: { host: '127.0.0.1:3081', cookie: c3081 } });
console.log('host=3081 + cookie3081 ->', r.status, (await r.text()).slice(0, 60).replace(/\n/g, ' '));
// 2. Host header 127.0.0.1:3081 + cookie for 3080
r = await fetch('http://127.0.0.1:3080/', { headers: { host: '127.0.0.1:3081', cookie: mint('127.0.0.1:3080') } });
console.log('host=3081 + cookie3080 ->', r.status);
// 3. api with host 3081 + cookie3081
r = await fetch('http://127.0.0.1:3080/api/pluginInventory/list', {
  method: 'POST',
  headers: { 'content-type': 'application/json', host: '127.0.0.1:3081', cookie: c3081 },
  body: JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'pluginInventory/list', payload: { args: {} } }),
});
console.log('api host=3081 + cookie3081 ->', r.status, (await r.text()).slice(0, 80));
// 4. WS upgrade with host 3081 + cookie3081
{
  const ws = new WebSocket('ws://127.0.0.1:3080/api/events.mux');
  ws.addEventListener('error', (e) => console.log('ws direct (no cookie) error:', e?.message ?? 'error'));
  await new Promise(r => setTimeout(r, 800));
  ws.close?.();
}
