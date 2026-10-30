#!/usr/bin/env node
/**
 * chrome-eye DK cookie receiver — pure Node (v24+), zero npm dependencies.
 *
 * Companion to bridge.mjs (which it deliberately does NOT modify). Binds
 * 127.0.0.1:3082 and receives session cookies from the Chrome Eye extension
 * for ALLOWLISTED origins only (default: https://www.draftkings.com).
 * See ../REQ-dk-cookies.md for the extension-side requirement this serves.
 *
 * Flow: the user stages a tab as context in the side panel; when the tab's
 * origin is allowlisted, sw.js POSTs the tab's cookies here (chrome.cookies
 * API — includes HttpOnly ones). The receiver:
 *
 *   - validates the origin against the allowlist (403 otherwise)
 *   - writes the full cookie header string ("a=b; c=d") to DK_COOKIE_FILE
 *     (default /mnt/f/ai/projects/nfl/data/keys/dk_session.txt), mode 0600
 *   - optionally spawns the salary ingest (body.run === true or
 *     DK_AUTO_INGEST=1):
 *       <DK_INGEST_CWD>/.venv/bin/python -m src.ingest_salaries \
 *           --cookie-file <file>
 *     (--seasons omitted: the script defaults to the current year)
 *     Output appends to dk-ingest.log with a timestamped banner. A second
 *     run while one is live is refused via a PID file (stale PIDs are
 *     detected by probe and cleared).
 *   - NEVER logs or echoes cookie values — responses carry metadata only
 *     (names, count, DK_SESSION expiry).
 *
 * Routes:
 *   GET  /health   -> 200 {ok, origins, cookieFile}
 *   POST /cookie   -> {origin, cookies:[{name,value,...}], run?:bool}
 *                     -> 200 {ok, saved, names, count, sessionExpires, run}
 *                     run ∈ "started" | "already-running" | "skipped"
 *   OPTIONS *      -> 204 (CORS preflight; same stance as bridge.mjs)
 *
 * Env:
 *   DK_RECEIVER_PORT   default 3082
 *   DK_COOKIE_ORIGINS  comma-separated, default "https://www.draftkings.com"
 *   DK_COOKIE_FILE     default /mnt/f/ai/projects/nfl/data/keys/dk_session.txt
 *   DK_INGEST_CWD      default /mnt/f/ai/projects/nfl
 *   DK_AUTO_INGEST     default 0; "1" makes every POST run the ingest
 *
 * Start:  node /mnt/f/ai/chrome-eye/bridge/dk-receiver.mjs
 */

import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, chmodSync, readFileSync, openSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HOST = '127.0.0.1';
const PORT = Number(process.env.DK_RECEIVER_PORT ?? 3082);
const ORIGINS = (process.env.DK_COOKIE_ORIGINS ?? 'https://www.draftkings.com')
  .split(',').map((s) => s.trim()).filter(Boolean);
const COOKIE_FILE = process.env.DK_COOKIE_FILE ?? '/mnt/f/ai/projects/nfl/data/keys/dk_session.txt';
const INGEST_CWD = process.env.DK_INGEST_CWD ?? '/mnt/f/ai/projects/nfl';
const AUTO_INGEST = process.env.DK_AUTO_INGEST === '1';
const MAX_BODY = 1 * 1024 * 1024; // cookie strings are small; 1 MB cap

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LOG_FILE = join(ROOT, 'bridge', 'dk-receiver.log');
const INGEST_LOG = join(ROOT, 'bridge', 'dk-ingest.log');
const PID_FILE = join(ROOT, 'bridge', 'dk-receiver.ingest.pid');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { writeFileSync(LOG_FILE, line, { flag: 'a' }); } catch { /* never die on logging */ }
  process.stdout.write(line);
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

// PID-file liveness: a dead probe means a stale pid from a finished run.
function ingestRunning() {
  if (!existsSync(PID_FILE)) return false;
  let pid;
  try { pid = Number(readFileSync(PID_FILE, 'utf8').trim()); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) { rmSync(PID_FILE, { force: true }); return false; }
  try { process.kill(pid, 0); return true; }
  catch { rmSync(PID_FILE, { force: true }); return false; }
}

function startIngest() {
  if (ingestRunning()) return 'already-running';
  const python = join(INGEST_CWD, '.venv', 'bin', 'python');
  if (!existsSync(python)) {
    log(`ingest skipped: python not found at ${python}`);
    return 'skipped';
  }
  const banner = `\n===== dk-receiver: ingest started ${new Date().toISOString()} =====\n`;
  const fd = openSync(INGEST_LOG, 'a');
  writeFileSync(INGEST_LOG, banner, { flag: 'a' });
  const child = spawn(python, ['-m', 'src.ingest_salaries', '--cookie-file', COOKIE_FILE], {
    cwd: INGEST_CWD,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.on('error', (err) => log(`ingest spawn error (survived): ${err.message}`));
  writeFileSync(PID_FILE, String(child.pid));
  child.unref();
  log(`ingest started pid=${child.pid} -> ${INGEST_LOG}`);
  return 'started';
}

function handleCookie(req, res, body) {
  let payload;
  try { payload = JSON.parse(body); }
  catch { return json(res, 400, { ok: false, error: 'body is not valid JSON' }); }

  const origin = typeof payload.origin === 'string' ? payload.origin : '';
  if (!ORIGINS.includes(origin)) {
    log(`rejected origin (not allowlisted): ${origin || '<missing>'}`);
    return json(res, 403, { ok: false, error: 'origin not allowlisted' });
  }

  const cookies = Array.isArray(payload.cookies)
    ? payload.cookies.filter((c) => c && typeof c.name === 'string' && typeof c.value === 'string' && c.name)
    : [];
  if (!cookies.length) {
    return json(res, 400, { ok: false, error: 'no valid cookies in payload' });
  }

  // Persist: full cookie header string, 0600, never logged.
  const header = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  mkdirSync(dirname(COOKIE_FILE), { recursive: true });
  writeFileSync(COOKIE_FILE, header + '\n', { mode: 0o600 });
  chmodSync(COOKIE_FILE, 0o600);

  const session = cookies.find((c) => c.name === 'DK_SESSION');
  const meta = {
    ok: true,
    saved: COOKIE_FILE,
    names: cookies.map((c) => c.name),
    count: cookies.length,
    sessionExpires: session && session.expirationDate
      ? new Date(session.expirationDate * 1000).toISOString()
      : (session ? 'session' : null),
  };

  if (payload.run === true || AUTO_INGEST) {
    meta.run = startIngest();
  } else {
    meta.run = 'skipped';
  }

  log(`cookie saved origin=${origin} count=${meta.count} run=${meta.run}`);
  return json(res, 200, meta);
}

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (req.method === 'GET' && req.url === '/health') {
    return json(res, 200, { ok: true, origins: ORIGINS, cookieFile: COOKIE_FILE });
  }

  if (req.method === 'POST' && req.url === '/cookie') {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        res.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        handleCookie(req, res, Buffer.concat(chunks).toString('utf8'));
      } catch (err) {
        log(`handler error (survived): ${err.message}`);
        if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
      }
    });
    req.on('error', () => { if (!res.headersSent) { try { res.end(); } catch { /* noop */ } } });
    return;
  }

  json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, HOST, () => {
  log(`dk-receiver listening on http://${HOST}:${PORT} origins=[${ORIGINS.join(', ')}] -> ${COOKIE_FILE}`);
});

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`dk-receiver: port ${PORT} is already in use; stop the other receiver first.`);
    process.exit(1);
  }
  log(`dk-receiver server error (survived): ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  log(`unhandledRejection (survived): ${reason?.message ?? reason}`);
});
process.on('uncaughtException', (err) => {
  log(`uncaughtException (survived): ${err.message}`);
});
