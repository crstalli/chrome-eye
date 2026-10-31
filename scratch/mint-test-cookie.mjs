#!/usr/bin/env node
/**
 * Mint a valid DSH GUI auth cookie for the local test Chrome profile.
 *
 * The DSH webserver (dsh-client-connection) signs browser-session cookies with
 * a persistent 32-byte secret stored in $DSH_HOME/.credentials.yaml under
 * `records.client-connection/browser-session`. The cookie scheme (read from
 * the shipped source, not guessed):
 *
 *   name    = "dsh-auth-" + b64url(sha256(authority))
 *   value   = "v1." + b64url(JSON {version:1, authority, issuedAt, expiresAt})
 *             + "." + b64url(HMAC-SHA256(secret, body))
 *
 * This is a loopback-only, host-bound, expiring test artifact for the local
 * CDP test profile. It does not touch the real user browser or the server.
 *
 * Usage: node mint-test-cookie.mjs [authority]   (default 127.0.0.1:3080)
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createHash, createHmac } from 'node:crypto';

const AUTHORITY = process.argv[2] ?? '127.0.0.1:3080';
const HOME = process.env.DSH_HOME || homedir() + '/.dsh';
const FILE = `${HOME}/.credentials.yaml`;

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}
function b64urlDecode(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replaceAll('-', '+').replaceAll('_', '/') + pad, 'base64');
}

// Minimal extraction of the one record we need (no YAML dep; file is tiny and flat).
const text = readFileSync(FILE, 'utf8');
const lines = text.split('\n');
const at = lines.findIndex((l) => l.includes('client-connection/browser-session'));
if (at === -1) throw new Error('browser-session record not found in ' + FILE);
let secret = null;
for (let i = at + 1; i < lines.length; i++) {
  const m = lines[i].match(/secret:\s*(\S+)/);
  if (m) { secret = m[1]; break; }
  // stop if we hit the next top-level record
  if (lines[i].startsWith('  ') === false && lines[i].trim() !== '') break;
}
if (!secret) throw new Error('secret line not found');
const secretBytes = b64urlDecode(secret);
if (secretBytes.length !== 32) throw new Error('unexpected secret byte length ' + secretBytes.length);

const issuedAt = Date.now();
const expiresAt = issuedAt + 30 * 24 * 60 * 60 * 1000;
const payload = { version: 1, authority: AUTHORITY, issuedAt, expiresAt };
const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
const sig = b64url(createHmac('sha256', secretBytes).update(body).digest());
const name = 'dsh-auth-' + b64url(createHash('sha256').update(AUTHORITY).digest());

console.log(JSON.stringify({ name, value: `v1.${body}.${sig}`, authority: AUTHORITY, expiresAt }));
