import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
const text = readFileSync('/home/cztl/.dsh/.credentials.yaml', 'utf8');
const m = text.match(/secret:\s*(\S+)/);
const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
const b64url = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
function mint(authority) {
  const name = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest());
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 30 * 86400000;
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return { name, value: `v1.${body}.${sig}` };
}
const { name, value } = mint('127.0.0.1:3080');
const res = await fetch('http://127.0.0.1:3080/api/pluginInventory/list', {
  method: 'POST',
  headers: { 'content-type': 'application/json', host: '127.0.0.1:3080', cookie: `${name}=${value}` },
  body: JSON.stringify({ type: 'client-request', rpcId: 'mint-test2', method: 'pluginInventory/list', payload: { args: {} } }),
});
const t = await res.text();
console.log('api/pluginInventory/list ->', res.status, t.slice(0, 120));
