// Throwaway (task E): verify cookie minting recipe against live :3080.
// Reads the secret from .credentials.yaml, mints for 127.0.0.1:3080,
// hits / and an /api endpoint with the cookie.
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const CREDS_PATH = process.argv[2] || '/home/cztl/.dsh/.credentials.yaml';

// Minimal flat-YAML read for the known fixed structure (no YAML lib, zero deps).
function readSecret(path) {
  const text = readFileSync(path, 'utf8');
  let inRecords = false, inRecord = false, inPayload = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!inRecords) {
      if (line === 'records:') inRecords = true;
      continue;
    }
    if (line === '') continue;
    if (line === line.trim() && /^[a-z-]+:/.test(line)) { inRecords = false; inRecord = false; inPayload = false; continue; } // new top-level key
    const ind = line.length - line.trimStart().length;
    if (!inRecord && ind === 2 && line.trim() === 'client-connection/browser-session:') { inRecord = true; continue; }
    if (!inRecord) continue;
    if (ind === 2 && line !== '  client-connection/browser-session:') { inRecord = false; inPayload = false; continue; } // sibling record
    if (inRecord && ind === 4 && line.trim() === 'payload:') { inPayload = true; continue; }
    if (inRecord && ind === 4) { inPayload = false; continue; } // other record-level field
    if (inPayload && ind === 6) {
      const m = line.trim().match(/^secret:\s*(\S+)\s*$/);
      if (m) return m[1];
    }
  }
  throw new Error('secret not found in ' + path);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

const secretStr = readSecret(CREDS_PATH);
const secret = Buffer.from(secretStr.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
console.log('secret bytes:', secret.byteLength);
if (secret.byteLength !== 32) throw new Error('secret is not 32 bytes');

function mint(authority) {
  const name = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest());
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 30 * 24 * 60 * 60 * 1000;
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return { name, value: `v1.${body}.${sig}` };
}

for (const authority of ['127.0.0.1:3080', '127.0.0.1:3081', 'localhost:3080']) {
  const { name, value } = mint(authority);
  const res = await fetch('http://127.0.0.1:3080/', { headers: { host: authority, cookie: `${name}=${value}` } });
  const text = await res.text();
  console.log(authority, '->', res.status, text.slice(0, 80).replace(/\n/g, ' '));
}

// /api endpoint with the 3080 cookie
{
  const { name, value } = mint('127.0.0.1:3080');
  const res = await fetch('http://127.0.0.1:3080/api/settings/get', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: '127.0.0.1:3080', cookie: `${name}=${value}` },
    body: JSON.stringify({ type: 'client-request', rpcId: 'mint-test', method: 'settings/get', payload: { args: {} } }),
  });
  const text = await res.text();
  console.log('api/settings/get ->', res.status, text.slice(0, 200));
}
