#!/usr/bin/env node
// cdp-proxy.mjs — run-side CDP HTTP shim that fixes the about:blank swap race.
//
// Problem: when a tab is created via `PUT /json/new?<url>`, the new target
// immediately reports its requested URL in /json, but its actual document is
// still about:blank — and about:blank already has readyState "complete". A
// harness that polls readyState right after /json/new can pass that wait on
// about:blank and then evaluate against the wrong document (the real panel
// document swaps in a few tens of ms later).
//
// Fix: this proxy listens on 127.0.0.1:9222, forwards CDP HTTP to the real
// endpoint on 127.0.0.1:9223, and holds the `PUT /json/new?<url>` response
// open until the new target's document has actually swapped to <url> (checked
// with a short-lived CDP connection that polls `location.href`). Response
// bodies pass through unchanged, so every webSocketDebuggerUrl still points
// at :9223 — all WebSocket traffic bypasses the proxy entirely (no WS framing
// to implement here).
//
// Usage: node test/cdp-proxy.mjs --listen 9222 --upstream 9223
import http from 'node:http';

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const LISTEN_PORT = Number(arg('listen', '9222'));
const CHROME_PORT = Number(arg('upstream', '9223'));
const UP = `http://127.0.0.1:${CHROME_PORT}`;
const SWAP_TIMEOUT_MS = 15000;

const log = (m) => console.log(`[cdp-proxy] ${m}`);

function respond(res, status, text) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=UTF-8',
    connection: 'close',
  });
  res.end(text);
}

async function readBody(req) {
  if (req.method !== 'PUT' && req.method !== 'POST') return undefined;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const b = Buffer.concat(chunks);
  return b.length ? b : undefined;
}

async function forward(req, res) {
  const body = await readBody(req);
  const r = await fetch(UP + req.url, {
    method: req.method,
    body,
    headers: body ? { 'content-type': 'application/json' } : {},
  });
  const text = await r.text();
  respond(res, r.status, text);
}

// One-shot CDP eval on a target; returns the value or throws.
function cdpEval(ws, id, expr) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', onMsg);
      reject(new Error('eval timeout'));
    }, 3000);
    function onMsg(m) {
      let v; try { v = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString()); } catch { return; }
      if (v.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMsg);
      v.error ? reject(new Error(v.error.message)) : resolve(v.result?.result?.value ?? null);
    }
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
  });
}

// Hold until the new target's document is no longer about:blank.
async function waitSwapped(target, wantedUrl) {
  let ws;
  try {
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('check ws failed to connect'));
    });
  } catch {
    return false;
  }
  const t0 = Date.now();
  let id = 0;
  try {
    while (Date.now() - t0 < SWAP_TIMEOUT_MS) {
      try {
        const href = await cdpEval(ws, ++id, 'location.href');
        if (href === wantedUrl) return true;
      } catch { /* transient — keep polling */ }
      await new Promise(r => setTimeout(r, 10));
    }
    return false;
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'PUT' && req.url.startsWith('/json/new')) {
      const t0 = Date.now();
      const r = await fetch(UP + req.url, { method: 'PUT' });
      const text = await r.text();
      let target = null;
      try { target = JSON.parse(text); } catch { /* non-JSON error body */ }
      if (r.ok && target?.id && target?.url && target.url !== 'about:blank') {
        const swapped = await waitSwapped(target, target.url);
        log(`/json/new ${target.url} -> ${swapped ? 'doc swapped' : 'SWAP TIMEOUT, responding anyway'} (+${Date.now() - t0}ms)`);
      }
      respond(res, r.status, text);
      return;
    }
    await forward(req, res);
  } catch (e) {
    log(`error on ${req.method} ${req.url}: ${e?.message || e}`);
    try { respond(res, 502, JSON.stringify({ error: String(e?.message || e) })); } catch { /* client gone */ }
  }
});

server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n'); } catch { /* ignore */ }
});

server.listen(LISTEN_PORT, '127.0.0.1', () => {
  log(`http://127.0.0.1:${LISTEN_PORT} -> ${UP} (ws urls pass through to :${CHROME_PORT} directly)`);
});
