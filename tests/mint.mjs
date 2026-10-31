// T12.7 — offline :3080 auth-cookie minter.
//
// The DSH web gate (dsh-client-connection/lib/index.js) signs session cookies
// with a PERSISTENT 32-byte secret stored in the DSH home credential record
// `client-connection/browser-session` (`.dsh/.credentials.yaml`). Launch tokens
// are process-scoped (WeakMap) and unreplayable, but the cookie signature can
// be reproduced offline from that secret — verified HTTP 200 against the live
// :3080 server (see STATE-T12.md "SOLVED: headless :3080 auth" section).
//
// SECURITY: the secret is read from disk at run time only. Never log it,
// never commit it into this repo.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createHmac, createHash } from 'node:crypto';

const b64u = (buf) =>
  Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

export function mintCookie({
  authority = '127.0.0.1:3080',
  days = 1,
  dshHome = null,
} = {}) {
  const home = dshHome || process.env.DSH_HOME || path.join(homedir(), '.dsh');
  const credPath = path.join(home, '.credentials.yaml');
  const raw = readFileSync(credPath, 'utf8');
  // The credential file has exactly one `secret:` line (under
  // records.client-connection/browser-session.payload).
  const m = raw.match(/secret:\s*([A-Za-z0-9_-]+)/);
  if (!m) throw new Error('no secret found in ' + credPath);
  const secret = Buffer.from(m[1], 'base64');
  if (secret.length !== 32) {
    throw new Error('secret decoded to ' + secret.length + ' bytes; expected 32');
  }
  const cookieName = 'dsh-auth-' + b64u(createHash('sha256').update(authority, 'utf8').digest());
  const DAY = 86400000;
  const issuedAt = Date.now();
  const expiresAt = issuedAt + days * DAY;
  const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'));
  const sig = b64u(createHmac('sha256', secret).update(body, 'utf8').digest());
  return { name: cookieName, value: 'v1.' + body + '.' + sig, authority, issuedAt, expiresAt };
}
