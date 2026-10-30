#!/usr/bin/env node
/**
 * chrome-eye loopback bridge — pure Node (v24+), zero npm dependencies.
 *
 * Binds 127.0.0.1:3081 and is a FULL reverse proxy to the DSH Web GUI at
 * 127.0.0.1:3080, so the extension's side-panel iframe (which cannot complete
 * the GUI's official SameSite=Strict cookie flow) renders the real GUI:
 *
 *   - Every non-/health, non-/share request (GET/POST/... any path) is
 *     forwarded verbatim to :3080 with the bridge's own minted auth cookie
 *     attached, so the upstream trust fence and cookie check both pass.
 *     The upstream Host header is always 127.0.0.1:3080 (the real authority
 *     the cookie is minted for), regardless of what the client sent.
 *   - The cookie is minted from the same secret the GUI uses
 *     (records["client-connection/browser-session"].payload.secret in
 *     ~/.dsh/.credentials.yaml): cookie NAME = "dsh-auth-" +
 *     base64url(sha256("127.0.0.1:3080")), VALUE = "v1." +
 *     base64url(JSON {version:1, authority, issuedAt, expiresAt}) + "." +
 *     base64url(HMAC-SHA256(secret, body)). It is re-minted before expiry
 *     (max 30-day TTL, per the upstream contract).
 *   - WebSocket upgrades for ANY /api/* path are proxied both ways: the
 *     bridge performs a manual raw-socket upgrade to ws://127.0.0.1:3080 on
 *     the same path, attaching the minted cookie (Host 127.0.0.1:3080) to
 *     the upgrade request, then pipes RFC6455 frames in both directions.
 *   - Origin/Referer/Sec-Fetch-* are still stripped from forwarded requests
 *     (the upstream trust fence rejects a cross-site Origin), and response
 *     framing headers are not replayed.
 *
 * Routes:
 *   GET  /health          -> 200 {"ok":true} (bridge liveness, no upstream)
 *   POST /share           -> inject a shared page into a session via
 *                            session.prompt (with the minted cookie) when the
 *                            payload carries a sessionId; otherwise fall back
 *                            to writing the payload to
 *                            ../captures/<unix-seconds>.json and reply
 *                            {"ok":true,"fallback":true,"path":...}
 *   GET  /session-seed    -> T2 session-restore seed script for the panel's
 *                            iframe origin (127.0.0.1:3081). The DSH GUI
 *                            restores its "current session" from the
 *                            browser-localStorage key dsh.sessions.current,
 *                            which is PER-ORIGIN — the :3081 origin the panel
 *                            iframe loads from has its own empty storage, so a
 *                            fresh panel boot has no session to resume. This
 *                            route resolves the id (explicit ?id=, else the
 *                            most-recent session via the upstream
 *                            /api/session/list unary route) and returns a tiny
 *                            <script> that writes {sessionId} into the
 *                            :3081-origin localStorage under that key, so the
 *                            GUI's own restore logic picks it up on the next
 *                            document load. It returns 404 when the id is
 *                            already present (the injected <script src> tag
 *                            then costs one harmless failed request). The HTML
 *                            document (GET /) is rewritten to inject
 *                            <script src="/session-seed"> into <head> BEFORE
 *                            the app bundle, so the write lands before
 *                            dsh-client-store rehydrates. No RPC wire change;
 *                            the extension still talks only to :3081.
 *   POST /cmd             -> accept an agent command {id, action, params} into
 *                            the pending store (the agent's chrome-eye model
 *                            tool posts this); the panel polls /cmd/pending
 *                            and relays it to the SW.
 *   GET  /cmd/pending     -> {ok, pending: [{id, action, params}]} — the
 *                            not-yet-answered commands, oldest first (the
 *                            panel's discovery channel).
 *   GET  /cmd?cmd=<id>    -> {status: pending|done|error, result?} for the
 *                            pending command (the model tool polls this).
 *   POST /cmd/result      -> the extension writes the executed command's
 *                            result back {id, result, error?}; a base64
 *                            result.image is dropped to captures/<id>.png and
 *                            replaced by result.imagePath.
 *   GET  /cmd/audit        -> the SQLite audit log of every command accepted
 *                            and result recorded. ?limit=N, ?since=<ms>,
 *                            ?cmd=<id> filter the results.
 *   ANY  /<anything else> -> reverse proxy to http://127.0.0.1:3080/<same path>
 *                            (streams body both ways, attaches the cookie)
 *   WS   /api/<anything>  -> RFC6455 pipe both ways to ws://127.0.0.1:3080/<same path>
 *
 * CORS (CP-6 requirement, supersedes the original no-CORS stance): the MV3
 * service worker POSTs to /share from an origin whose host_permissions do NOT
 * cover :3081, so the browser treats it as cross-origin and sends a preflight.
 * The bridge therefore answers OPTIONS preflights for /share and the /api/*
 * unary routes (204, no body) and stamps Access-Control-Allow-Origin on all
 * JSON responses. Accepted trade-off, per CP-6: any page on this machine can
 * now reach :3081 cross-origin (the bridge still only binds loopback and the
 * upstream trust fence still applies to what :3080 accepts).
 */

import { createServer } from 'node:http';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import wsPkg from '/mnt/f/npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/ws/index.js';
const { WebSocket: WSClient, WebSocketServer: WSServer } = wsPkg;
import { DatabaseSync as SQLiteDB } from 'node:sqlite';

// Both endpoints are configurable via env so the stack can attach to the
// user's own dsh web GUI on any port. Defaults keep the historical layout:
// GUI on :3080 (upstream) and bridge on :3081 (the panel iframe's only
// allowed target — the trust fence is unchanged).
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.CHROME_EYE_GUI_PORT ?? 3080);
const UPSTREAM_HTTP = `http://${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
const UPSTREAM_AUTHORITY = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
const HOST = '127.0.0.1';
const PORT = Number(process.env.CHROME_EYE_BRIDGE_PORT ?? 3081);
const MAX_BODY = 64 * 1024 * 1024; // base64 screenshots can be several MB

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // /mnt/f/ai/chrome-eye
const CAPTURES_DIR = join(ROOT, 'captures');
const AUDIT_DB_PATH = join(ROOT, 'captures', 'audit.db');


// --- audit log (SQLite via node:sqlite) -------------------------------------
// Records every command accepted and every result received, so the full
// history of what the agent did on the browser is reviewable offline.

let auditDb = null;
let auditStmtAccept = null;
let auditStmtResult = null;

function initAudit() {
  try {
    mkdirSync(CAPTURES_DIR, { recursive: true });
    auditDb = new SQLiteDB(AUDIT_DB_PATH);
    auditDb.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS commands (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        cmd_id TEXT NOT NULL UNIQUE,
        action TEXT NOT NULL,
        params TEXT,
        created_at INTEGER NOT NULL,
        result_json TEXT,
        error TEXT,
        image_path TEXT,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_commands_created_at ON commands(created_at DESC);
    `);
    auditStmtAccept = auditDb.prepare(`
      INSERT OR IGNORE INTO commands (cmd_id, action, params, created_at)
      VALUES (?, ?, ?, ?)
    `);
    auditStmtResult = auditDb.prepare(`
      UPDATE commands
      SET result_json = ?, error = ?, image_path = ?, completed_at = ?
      WHERE cmd_id = ?
    `);
    log('audit db initialized', AUDIT_DB_PATH);
  } catch (err) {
    console.error('audit db failed to init:', err.message);
    auditDb = null;
  }
}

function auditAccept(id, action, params) {
  if (auditDb && auditStmtAccept) {
    try {
      auditStmtAccept.run(
        id,
        action,
        params ? JSON.stringify(params) : null,
        Date.now()
      );
    } catch (err) {
      // Best-effort; a DB hiccup must not break the command channel.
      console.error('audit accept failed:', err.message);
    }
  }
}

function auditResult(id, result, error, imagePath) {
  if (auditDb && auditStmtResult) {
    try {
      auditStmtResult.run(
        result ? JSON.stringify(result) : null,
        error ? String(error) : null,
        imagePath ?? null,
        Date.now(),
        id
      );
    } catch (err) {
      console.error('audit result failed:', err.message);
    }
  }
}

initAudit();


// --- minted auth cookie (mirrors @deepseek-ai/dsh-client-connection) --------

const CREDS_PATH = join(homedir(), '.dsh', '.credentials.yaml');
const COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // upstream hard cap
const REMINT_BEFORE_MS = 10 * 60 * 1000; // re-mint 10 min before expiry

let cookieSecret = null;
let cookieCache = null; // { header, expiresAt }

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

function loadSecret() {
  if (cookieSecret !== null) return cookieSecret;
  const secretStr = readSecret(CREDS_PATH);
  const secret = Buffer.from(secretStr.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  if (secret.byteLength !== 32) throw new Error('dsh browser-session secret is not 32 bytes');
  cookieSecret = secret;
  return secret;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function mintCookie(authority) {
  const secret = loadSecret();
  const name = 'dsh-auth-' + b64url(createHash('sha256').update(authority, 'utf8').digest());
  const issuedAt = Date.now();
  const expiresAt = issuedAt + COOKIE_TTL_MS;
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return { name, value: `v1.${body}.${sig}`, expiresAt };
}

/** Header value for one authenticated request; re-mints before expiry. */
function authCookieHeader() {
  const now = Date.now();
  if (!cookieCache || cookieCache.expiresAt - REMINT_BEFORE_MS <= now) {
    const c = mintCookie(UPSTREAM_AUTHORITY);
    cookieCache = { header: `${c.name}=${c.value}`, expiresAt: c.expiresAt };
  }
  return cookieCache.header;
}

// Request headers the trust fence or the upstream would misread.
const STRIP_REQUEST_HEADERS = new Set([
  'origin',
  'referer',
  'sec-fetch-site',
  'sec-fetch-mode',
  'sec-fetch-dest',
  'host',
  'cookie',
  'content-length',
  'connection',
  'upgrade',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-protocol',
  'sec-websocket-extensions',
]);
// Response headers that must not be replayed (Node fetch auto-decompresses).
const STRIP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
]);

// CORS headers for the cross-origin MV3 service worker (CP-6). The two headers
// named in the requirement are ACAO + Access-Control-Allow-Content-Type; the
// standard Access-Control-Allow-Headers/Methods companions are included as
// well because browsers only let a non-simple Content-Type: application/json
// request through when Allow-Headers covers content-type.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-content-type': 'application/json',
  'access-control-allow-headers': 'content-type, accept',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// T2 diagnostics: every seed resolution and HTML rewrite is logged (stderr)
// so the panel's restore path is visible in the bridge's stack.log. The
// session id is loopback-only data (the bridge binds 127.0.0.1, the GUI is
// the user's own DSH) — still, no transcript content crosses the log.

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

// --- generic reverse proxy --------------------------------------------------

// Long-lived upstream routes that intentionally hold their body open
// (server-push / HMR / event streams). The upstream never ends these on
// its own, so undici's default bodyTimeout must not apply to them.
function isLongLived(url) {
  const p = url.pathname;
  if (p === '/plugins/events') return true;
  if (p.startsWith('/api/')) return true;
  return /\/(events|stream|logs|hmr|ws)([/?]|$)/.test(p);
}

// fetch() does not expose undici dispatcher options in its public API, so the
// only way to raise the body timeout is to build the request with the
// undici Client/Pool dispatcher. Node >= 20 ships undici internally; we
// import it via the `node:`-injected global `fetch`'s dispatcher option,
// which is NOT supported. Instead we use a raw http.request for long-lived
// routes (same approach as the WS path) and fetch() for everything else.
async function forwardLongLived(req, res, url) {
  const isBodyless = ['GET', 'HEAD'].includes(req.method);
  const body = isBodyless ? null : await readBody(req);
  const headers = { ...req.headers };
  for (const name of Object.keys(headers)) {
    if (STRIP_REQUEST_HEADERS.has(name.toLowerCase())) delete headers[name];
  }
  // raw httpRequest does NOT auto-decompress like fetch() does. Strip
  // accept-encoding so upstream always returns plain (uncompressed) bytes;
  // content-encoding is already stripped from response headers, so the
  // client would receive raw gzip labeled as plain JSON → JSON.parse fails.
  delete headers['accept-encoding'];
  headers.host = UPSTREAM_AUTHORITY;
  headers.cookie = authCookieHeader();
  if (body) headers['content-length'] = String(body.length);

  const upReq = httpRequest({
    host: UPSTREAM_HOST,
    port: UPSTREAM_PORT,
    method: req.method,
    path: url.pathname + url.search,
    headers,
  }, (upRes) => {
    const respHeaders = {};
    for (const [name, value] of Object.entries(upRes.headers)) {
      if (!STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) respHeaders[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    res.writeHead(upRes.statusCode, { ...CORS_HEADERS, ...respHeaders });
    if (req.method === 'HEAD' || upRes.statusCode === 204 || upRes.statusCode === 304) {
      res.end();
      upReq.destroy();
      return;
    }
    let settled = false;
    const done = () => { if (!settled) { settled = true; } };
    upRes.on('data', (chunk) => {
      if (!res.write(chunk)) res.once('drain', () => { /* keep going */ });
    });
    upRes.on('end', () => { res.end(); done(); });
    upRes.on('error', (err) => {
      log('long-lived upstream error', url.pathname, err?.message);
      if (!res.writableEnded) res.end();
      done();
    });
    res.on('close', () => {
      // client went away — abort upstream
      if (!settled) { settled = true; upReq.destroy(); }
    });
    upRes.on('aborted', () => {
      if (!res.writableEnded) res.end();
      done();
    });
  });
  upReq.on('error', (err) => {
    log('long-lived upstream request error', url.pathname, err?.message);
    if (!res.headersSent) {
      sendJson(res, 502, { ok: false, error: 'upstream unreachable: ' + (err?.message ?? String(err)) }, CORS_HEADERS);
    } else if (!res.writableEnded) {
      res.end();
    }
  });
  if (body) upReq.end(body);
  else upReq.end();
}

async function forward(req, res, url) {
  if (isLongLived(url)) {
    return forwardLongLived(req, res, url);
  }
  const body = ['GET', 'HEAD'].includes(req.method)
    ? undefined
    : await readBody(req);
  const headers = { ...req.headers };
  for (const name of Object.keys(headers)) {
    if (STRIP_REQUEST_HEADERS.has(name.toLowerCase())) delete headers[name];
  }
  headers.host = UPSTREAM_AUTHORITY;
  headers.cookie = authCookieHeader();
  const upstream = await fetch(UPSTREAM_HTTP + url.pathname + url.search, {
    method: req.method,
    headers,
    body,
    redirect: 'manual',
  });
  const respHeaders = {};
  upstream.headers.forEach((value, name) => {
    if (!STRIP_RESPONSE_HEADERS.has(name)) respHeaders[name] = value;
  });
  // T2 — the GUI's HTML document: rewrite it in memory to inject the
  // session-seed <script> into <head> (before the app bundle rehydrates the
  // per-origin localStorage cell). Only GET / with an HTML content-type is
  // touched; everything else streams verbatim.
  const isHtmlDoc =
    req.method === 'GET' &&
    url.pathname === '/' &&
    upstream.status === 200 &&
    String(upstream.headers.get('content-type') || '').toLowerCase().includes('text/html');
  if (isHtmlDoc) {
    const html = await upstream.text();
    const rewritten = withSeedScript(html);
    if (rewritten !== null) {
      log('seed: injected /session-seed script into HTML head (len ' + html.length + ' → ' + rewritten.length + ')');
      delete respHeaders['content-length'];
      res.writeHead(upstream.status, { ...CORS_HEADERS, ...respHeaders });
      res.end(rewritten);
      // The body is already consumed by upstream.text() (the stream is
      // "locked"); cancel() on a locked ReadableStream would throw an
      // unhandled rejection — nothing is left to release.
      return;
    }
    log('seed: HTML document not rewritten (no <head> or already injected)');
  }
  res.writeHead(upstream.status, { ...CORS_HEADERS, ...respHeaders });
  if (req.method === 'HEAD' || upstream.status === 204 || upstream.status === 304) {
    res.end();
    return;
  }
  try {
    for await (const chunk of upstream.body) {
      if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  } finally {
    // release any upstream resources on early client abort
    try { upstream.body?.cancel?.(); } catch { /* ignore */ }
  }
}

// --- /session-seed (T2) -------------------------------------------------------
//
// The DSH GUI (apps/web) restores its "current session" from the
// browser-localStorage key "dsh.sessions.current" (dsh-client-store
// createSnapshotStore, persist:{name} → real localStorage.getItem/setItem).
// localStorage is partitioned PER ORIGIN: the panel iframe loads the GUI from
// 127.0.0.1:3081 (this bridge) while the user's direct GUI usage lives on
// 127.0.0.1:3080 (or whatever GUI port the stack attached to). The :3081
// origin therefore starts with an EMPTY storage cell and the GUI's own
// restore logic (ClientSessions → SessionManager(selected) → projectList →
// followCurrent → session.open) has nothing to resume — a fresh panel boot
// lands on a blank/new session.
//
// Fix (chrome-eye-side, no DSH source change, no RPC wire change): when the
// bridge serves the HTML document (GET /) it injects
//   <script src="/session-seed"></script>
// into <head>, BEFORE the app bundle executes. That script's fetch lands in
// the :3081-origin document (same-origin read/write of localStorage is
// allowed), and the bridge resolves the session id to seed:
//   1. explicit ?id= query param (the extension content script, which can
//      read the frame's own localStorage, reports the current value back and
//      re-requests with ?id= only when the cell is empty);
//   2. otherwise the most-recent session on the host, resolved through the
//      same auth-cookie flow the rest of the bridge uses
//      (POST /api/session/list, the GUI's own unary RPC).
// The response is a one-line <script> that writes
//   localStorage.setItem('dsh.sessions.current', JSON.stringify({sessionId}))
// guarded by try/catch and by "only when empty" (a session the user opened
// in the panel is never clobbered). When the cell already holds an id, this
// route answers 404 instead (the injected <script src> costs one cheap
// failed request — same cost the app's 404ing /favicon.ico already pays).
//
// Security posture is unchanged: the bridge still binds 127.0.0.1 only, the
// extension still talks only to :3081, and the RPC wire is untouched.

const SEED_KEY = 'dsh.sessions.current';

async function resolveMostRecentSessionId() {
  // Same unary RPC the GUI client itself uses: /api/session/list expects a
  // client-request envelope whose method is the path in slashes and whose
  // args carry _request. Items come back newest-first (updatedAt desc).
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: 'chrome-eye-seed-' + Date.now(),
    method: 'session/list',
    payload: { args: { _request: {} } },
  });
  const upstream = await fetch(UPSTREAM_HTTP + '/api/session/list', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      host: UPSTREAM_AUTHORITY,
      cookie: authCookieHeader(),
    },
    body,
    redirect: 'manual',
  });
  if (upstream.status < 200 || upstream.status >= 300) return null;
  const text = await upstream.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { return null; }
  const items = parsed && parsed.result && Array.isArray(parsed.result.value?.items)
    ? parsed.result.value.items
    : [];
  if (items.length === 0) return null;
  const latest = items.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a), items[0]);
  return typeof latest?.sessionId === 'string' && latest.sessionId.length > 0
    ? latest.sessionId
    : null;
}

function seedScriptBody(sessionId) {
  // One-line, self-contained, exception-safe. Runs in the :3081-origin
  // document (injected into <head> of the proxied HTML), so localStorage
  // here IS the origin the GUI rehydrates from.
  return (
    '(function(){try{var k="' + SEED_KEY + '";' +
    'if(!localStorage.getItem(k)){' +
    'localStorage.setItem(k,JSON.stringify({sessionId:' + JSON.stringify(sessionId) + '}));' +
    '}}catch(e){}})();'
  );
}

function sendSeedScript(res, sessionId) {
  res.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': 'no-store',
    ...CORS_HEADERS,
  });
  res.end(seedScriptBody(sessionId));
}

async function handleSessionSeed(req, res, url) {
  const explicit = url.searchParams.get('id');
  if (explicit) {
    // The extension content script only requests a seed when the :3081
    // origin's cell is empty, so write unconditionally (still guarded in the
    // script body as a second line of defense).
    log('seed: explicit id requested — seeding ' + explicit.slice(0, 24) + '…');
    return sendSeedScript(res, explicit);
  }
  // No explicit id: resolve the latest session on the host (the injected
  // <script src="/session-seed"> in the document head, and the panel.js
  // "resolve" probe, both land here).
  let id = null;
  try {
    id = await resolveMostRecentSessionId();
  } catch (err) {
    log('session-seed: upstream session.list failed', err?.message ?? String(err));
  }
  if (id === null) {
    // No id to seed (upstream down, no sessions, or not resolvable).
    // 404: the injected <script src> tag simply fails cheaply.
    log('seed: no seedable session resolved (404)');
    sendJson(res, 404, { ok: false, error: 'no seedable session' }, CORS_HEADERS);
    return;
  }
  log('seed: resolved latest session ' + id.slice(0, 24) + '… — seeding');
  sendSeedScript(res, id);
}

// Rewrite the proxied HTML document: inject the seed <script> into <head>
// (before any app <script>, so the localStorage write precedes the
// dsh-client-store rehydration). The upstream document's <head> begins with
// <base href="/">, so an ABSOLUTE /session-seed src resolves against the
// root — no relative-path hazard. Returns null when the body is not a
// document we recognize — the bridge then streams the original bytes.
function withSeedScript(html) {
  const headEnd = html.search(/<\/head>/i);
  if (headEnd < 0) return null;
  if (/<script[^>]+src=["']\/session-seed/i.test(html)) return null; // already there
  const tag = '<script src="/session-seed"></script>';
  return html.slice(0, headEnd) + tag + html.slice(headEnd);
}

// --- /share -------------------------------------------------------------------

async function handleShare(req, res) {
  let payload;
  try {
    payload = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  } catch (err) {
    return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }, CORS_HEADERS);
  }
  if (payload && typeof payload.sessionId === 'string' && payload.sessionId.length > 0) {
    // Inject the shared page into the session as a prompt (cookie-authenticated).
    const prompt = JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method: 'session.prompt',
      payload: { args: { sessionId: payload.sessionId, text: renderShareText(payload) } },
    });
    try {
      const upstream = await fetch(`${UPSTREAM_HTTP}/api/session.prompt`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: UPSTREAM_AUTHORITY,
          cookie: authCookieHeader(),
        },
        body: prompt,
        redirect: 'manual',
      });
      const text = await upstream.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* not JSON; forward raw */ }
      if (parsed && parsed.type === 'server-response' && parsed.result?.ok === true) {
        return sendJson(res, 200, { ok: true, injected: true, rpcId: parsed.rpcId }, CORS_HEADERS);
      }
      const status = upstream.status >= 200 && upstream.status < 300 ? 200 : upstream.status;
      return sendJson(res, status, { ok: false, upstreamStatus: upstream.status, detail: parsed ?? text.slice(0, 400) }, CORS_HEADERS);
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: 'upstream session.prompt failed: ' + (err?.message ?? String(err)) }, CORS_HEADERS);
    }
  }
  // Fallback: capture to disk.
  mkdirSync(CAPTURES_DIR, { recursive: true });
  const ts = Math.floor(Date.now() / 1000);
  const path = join(CAPTURES_DIR, `${ts}.json`);
  writeFileSync(path, JSON.stringify({ receivedAt: new Date().toISOString(), ...payload }, null, 2));
  log('share fallback capture', path);
  sendJson(res, 200, { ok: true, fallback: true, path }, CORS_HEADERS);
}

function renderShareText(p) {
  const lines = [];
  if (p.url) lines.push(`Shared page: ${p.url}`);
  if (p.title) lines.push(`Title: ${p.title}`);
  if (p.visibleText) lines.push(`\n--- visible text ---\n${p.visibleText}`);
  if (Array.isArray(p.links) && p.links.length) lines.push(`\n--- links ---\n${p.links.join('\n')}`);
  if (Array.isArray(p.headings) && p.headings.length) lines.push(`\n--- headings ---\n${p.headings.join('\n')}`);
  return lines.join('\n');
}

// --- /cmd — the agent → extension command channel ----------------------------
//
// The DSH agent reaches the browser through a Host model tool (chrome-eye)
// that POSTs a command here; the extension's side panel polls GET /cmd and
// relays each command to the service worker, which executes it on the target
// tab (drive the active content tab: click/type/navigate, or screenshot).
// The result comes back over POST /cmd/result, where any base64 image is
// dropped to disk (CAPTURES_DIR/<id>.png) and only the on-disk PATH is kept
// in the pending store — the tool never carries raw base64 in its JSON.
//
// Loopback-only, no upstream trust fence involved (the command never touches
// :3080). Pending entries expire so a dead command cannot linger.

const CMD_PENDING_TTL_MS = 120 * 1000; // a command not completed in 2 min is dropped
const cmdPending = new Map(); // id -> { id, action, params, createdAt, result?, error? }

function cmdIdOk(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
}

function cmdStore(action, params, id) {
  const now = Date.now();
  // Expire stale pending commands (their result will never come back).
  for (const [k, v] of cmdPending) if (now - v.createdAt > CMD_PENDING_TTL_MS) cmdPending.delete(k);
  const key = id ?? randomUUID();
  cmdPending.set(key, { id: key, action, params, createdAt: now });
  return key;
}

// Snapshot a pending entry for the GET response (status + result/error).
function cmdView(entry) {
  if (!entry) return null;
  if (entry.result !== undefined) return { status: 'done', result: entry.result };
  if (entry.error !== undefined) return { status: 'error', error: entry.error };
  return { status: 'pending' };
}

// List of pending (not-yet-relayed) commands, oldest first — the panel polls
// this to discover new agent commands and relay each to the service worker.
// A command is "pending" until its result comes back (the panel is the relay,
// so the bridge cannot tell "delivered" apart from "executed" — it only knows
// "result has arrived"). The panel keeps its own relayed-set to avoid
// double-execution across restarts of the poll loop.
function cmdPendingList() {
  const now = Date.now();
  const out = [];
  for (const [k, v] of cmdPending) {
    if (now - v.createdAt > CMD_PENDING_TTL_MS) { cmdPending.delete(k); continue; }
    if (v.result !== undefined || v.error !== undefined) continue; // already answered
    if (!v.action) continue; // pre-registered but no action posted yet
    out.push({ id: v.id, action: v.action, params: v.params ?? null });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : 1)); // stable; id encodes creation order
  return out;
}

async function handleCmd(req, res, url) {
  const raw = (await readBody(req)).toString('utf8') || '{}';
  let body;
  try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }, CORS_HEADERS); }
  const id = typeof body.id === 'string' ? body.id : null;
  if (!id || !cmdIdOk(id)) {
    return sendJson(res, 400, { ok: false, error: 'body.id must be a string of [a-zA-Z0-9_-] (<=128)' }, CORS_HEADERS);
  }
  const action = typeof body.action === 'string' ? body.action : null;
  const params = body.params && typeof body.params === 'object' ? body.params : null;
  if (!action) {
    return sendJson(res, 400, { ok: false, error: 'body.action is required (screenshot|click|type|navigate)' }, CORS_HEADERS);
  }
  if (!cmdPending.has(id)) {
    cmdPending.set(id, { id, action, params, createdAt: Date.now() });
  }
  log('cmd accept', id, action, params ? JSON.stringify(params).slice(0, 200) : '(no params)');
  auditAccept(id, action, params);
  sendJson(res, 200, { ok: true, id }, CORS_HEADERS);
}

async function handleCmdResult(req, res) {
  const raw = (await readBody(req)).toString('utf8') || '{}';
  let body;
  try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }, CORS_HEADERS); }
  const id = typeof body.id === 'string' ? body.id : null;
  if (!id || !cmdIdOk(id)) {
    return sendJson(res, 400, { ok: false, error: 'body.id must be a string of [a-zA-Z0-9_-] (<=128)' }, CORS_HEADERS);
  }
  const entry = cmdPending.get(id);
  if (!entry) {
    // The command already expired (or the panel relayed a stale result).
    return sendJson(res, 200, { ok: false, error: 'unknown or expired command id' }, CORS_HEADERS);
  }
  const result = body.result !== undefined ? body.result : {};
  const error = body.error !== undefined ? body.error : null;
  // Keep the base64 image in-memory so the GET endpoint can return it inline.
  // (No disk write — avoids I/O on fast SSDs when agents capture repeatedly.)
  // The image stays in the result for the tool to surface to the agent.
  entry.result = result;
  entry.error = error;
  auditResult(id, result, error, null);
  sendJson(res, 200, { ok: true, id, imagePath: image ?? undefined }, CORS_HEADERS);
}

// --- WebSocket upgrade proxy (ws-library based) --------------------------------
//
// Uses the `ws` npm package (bundled with @deepseek-ai/dsh) for both the
// client-side upgrade (via WebSocketServer.handleUpgrade) and the upstream
// connection (via new WebSocket(url, {headers})). This replaces the old
// raw-socket RFC6455 frame pump, which had a subtle bug that caused the
// upstream to close the connection after receiving session/follow frames.

const wsProxy = new WSServer({ noServer: true });

async function handleUpgrade(req, socket, head, url) {
  if (!url.pathname.startsWith('/api/')) {
    socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  log(`ws upgrade ${url.pathname + url.search}`);
  try {
    // Connect to upstream using the ws client (supports custom headers)
    const upstreamUrl = `ws://${UPSTREAM_HOST}:${UPSTREAM_PORT}${url.pathname}${url.search}`;
    const upstream = new WSClient(upstreamUrl, {
      headers: {
        'Cookie': authCookieHeader(),
        'Origin': `http://${UPSTREAM_AUTHORITY}`,
      },
    });

    await new Promise((resolve, reject) => {
      upstream.once('open', resolve);
      upstream.once('error', reject);
      const t = setTimeout(() => reject(new Error('upstream ws connect timeout')), 8000);
      t.unref?.();
    });
    log(`ws upstream connected ${url.pathname}`);

    // Perform the client-side upgrade using the ws server
    wsProxy.handleUpgrade(req, socket, head, (clientWs) => {
      log(`ws client connected ${url.pathname}`);

      // Bridge: client → upstream
      clientWs.on('message', (data, isBinary) => {
        upstream.send(data, { binary: isBinary });
      });
      clientWs.on('close', (code, reason) => {
        log(`ws client closed ${url.pathname} ${code} ${reason?.toString() ?? ''}`);
        try { upstream.close(); } catch { /* ignore */ }
      });
      clientWs.on('error', (err) => {
        log(`ws client error ${url.pathname} ${err?.message}`);
        try { upstream.close(); } catch { /* ignore */ }
      });

      // Bridge: upstream → client
      upstream.on('message', (data, isBinary) => {
        clientWs.send(data, { binary: isBinary });
      });
      upstream.on('close', (code, reason) => {
        log(`ws upstream closed ${url.pathname} ${code} ${reason?.toString() ?? ''}`);
        try { clientWs.close(); } catch { /* ignore */ }
      });
      upstream.on('error', (err) => {
        log(`ws upstream error ${url.pathname} ${err?.message}`);
        try { clientWs.close(); } catch { /* ignore */ }
      });
    });
  } catch (err) {
    log(`ws upgrade failed ${url.pathname} ${err?.message}`);
    try {
      socket.write('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    } catch { /* ignore */ }
    socket.destroy();
  }
}

// --- server -------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'OPTIONS') {
      // CORS preflight for the cross-origin MV3 service worker (CP-6).
      res.writeHead(204, {
        ...CORS_HEADERS,
        'access-control-max-age': '86400',
      });
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true }, CORS_HEADERS);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/share') {
      await handleShare(req, res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/session-seed') {
      await handleSessionSeed(req, res, url);
      return;
    }
    if (url.pathname === '/cmd/pending') {
      if (req.method === 'GET') {
        return sendJson(res, 200, { ok: true, pending: cmdPendingList() }, CORS_HEADERS);
      }
      return sendJson(res, 405, { ok: false, error: 'method not allowed' }, CORS_HEADERS);
    }
    if (url.pathname === '/cmd') {
      if (req.method === 'POST') { await handleCmd(req, res, url); return; }
      if (req.method === 'GET') {
        const id = url.searchParams.get('cmd') || '';
        if (!id || !cmdIdOk(id)) {
          return sendJson(res, 400, { ok: false, error: 'missing or invalid ?cmd=<id>' }, CORS_HEADERS);
        }
        return sendJson(res, 200, cmdView(cmdPending.get(id)) ?? { status: 'pending' }, CORS_HEADERS);
      }
      return sendJson(res, 405, { ok: false, error: 'method not allowed' }, CORS_HEADERS);
    }
    if (req.method === 'POST' && url.pathname === '/cmd/result') {
      await handleCmdResult(req, res);
      return;
    }
    if (url.pathname === '/cmd/audit' && req.method === 'GET') {
      // Read the SQLite audit DB and return rows as JSON.
      // ?limit=N (default 50), ?since=<timestamp-ms>, ?cmd=<cmd_id>
      const limit = Number(url.searchParams.get('limit')) || 50;
      const since = url.searchParams.get('since') ? Number(url.searchParams.get('since')) : 0;
      const cmd = url.searchParams.get('cmd');
      if (auditDb) {
        let rows = [];
        try {
          let sql = 'SELECT rowid, cmd_id, action, params, created_at, result_json, error, image_path, completed_at FROM commands WHERE created_at >= ?';
          const args = [since];
          if (cmd) {
            sql += ' AND cmd_id = ?';
            args.push(cmd);
          }
          sql += ' ORDER BY created_at DESC LIMIT ?';
          args.push(Math.min(limit, 1000));
          rows = auditDb.prepare(sql).all(...args);
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err?.message }, CORS_HEADERS);
        }
        sendJson(res, 200, { ok: true, total: rows.length, commands: rows }, CORS_HEADERS);
      } else {
        sendJson(res, 503, { ok: false, error: 'audit db not initialized' }, CORS_HEADERS);
      }
    }
    // Everything else: full reverse proxy to the GUI (auth cookie attached).
    // The HTML document (GET /) is rewritten to inject the T2 session-restore
    // seed script; every other response streams verbatim.
    await forward(req, res, url);
  } catch (err) {
    log('request error', req.method, url.pathname, err?.message);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: err?.message ?? String(err) }, CORS_HEADERS);
    else res.end();
  }
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  handleUpgrade(req, socket, head, url);
});

server.on('clientError', (err, socket) => {
  log('client error', err?.message);
  socket.destroy();
});

server.listen(PORT, HOST, () => {
  log(`chrome-eye bridge listening on http://${HOST}:${PORT} -> ${UPSTREAM_HTTP} (auth proxy, cookie minted for ${UPSTREAM_AUTHORITY})`);
});

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`bridge: port ${PORT} is already in use; stop the other bridge first.`);
    process.exit(1);
  }
  // Non-fatal server errors (e.g. a client socket that closed mid-handshake).
  log('bridge server error', err?.message ?? String(err));
});

// The proxy must survive ANY single request failure. A fetch abort, an
// upstream 5xx, or a dropped client connection must never escape the
// request handler and kill the process.
process.on('unhandledRejection', (reason) => {
  log('unhandledRejection (survived)', reason?.message ?? reason ?? String(reason));
});
process.on('uncaughtException', (err) => {
  log('uncaughtException (survived)', err?.message ?? String(err));
});
