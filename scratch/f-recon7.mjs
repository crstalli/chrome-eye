#!/usr/bin/env node
// Diagnostic: in-frame fetch with the app's own Accept headers; inspect WS traffic.
const BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const cdp = new Cdp(ws);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString()); } catch { return; }
      if (msg.id && cdp.pending.has(msg.id)) {
        const p = cdp.pending.get(msg.id);
        clearTimeout(p.timer); cdp.pending.delete(msg.id);
        msg.error ? p.reject(new Error('CDP ' + msg.error.message)) : p.resolve(msg.result);
      } else if (!msg.id) { for (const h of cdp.handlers) { try { h(msg); } catch {} } }
    };
    return cdp;
  }
  send(method, params = {}, sessionId, timeoutMs = 25000) {
    const id = ++this.id;
    const e = { id, method, params };
    if (sessionId) e.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(e));
    });
  }
  on(handler) { this.handlers.push(handler); }
  close() { try { this.ws.close(); } catch {} }
}
async function browserWs() {
  const r = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(3000) });
  return (await r.json()).webSocketDebuggerUrl;
}
const cdp = await Cdp.connect(await browserWs());
await cdp.send('Target.setDiscoverTargets', { discover: true });
const t = await cdp.send('Target.getTargets');
const iframe = t.targetInfos.find((x) => x.type === 'iframe' && x.url && x.url.indexOf('3081') !== -1);
if (!iframe) { console.log('NO IFRAME'); process.exit(1); }
const att = await cdp.send('Target.attachToTarget', { targetId: iframe.targetId, flatten: true });
const s = att.sessionId;
await cdp.send('Runtime.enable', {}, s);
const ev = async (expr, timeoutMs = 25000) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s, timeoutMs);
  if (r.exceptionDetails) return 'EVAL_ERR: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
};
// 1) fetch session/list with app-style accept header
const f1 = await ev(`(async function(){
  try {
    var r = await fetch('/api/session/list', { headers: { accept: 'application/json' } });
    var ct = r.headers.get('content-type');
    var buf = await r.arrayBuffer();
    var b = new Uint8Array(buf);
    var head = '';
    for (var i = 0; i < Math.min(24, b.length); i++) head += b[i] < 32 || b[i] > 126 ? '.' : String.fromCharCode(b[i]);
    return { status: r.status, contentType: ct, len: b.length, head: head };
  } catch (e) { return 'ERR ' + e.message; }
})()`);
console.log('fetch session/list (accept: application/json):', JSON.stringify(f1));
// 2) check the performance entry for the ORIGINAL session/list call — responseStatus
const perf = await ev(`(function(){
  var out = [];
  for (var i = 0; i < performance.getEntriesByType('resource').length; i++) {
    var e = performance.getEntriesByType('resource')[i];
    if (e.name.indexOf('session/list') !== -1) out.push({ name: e.name, status: e.responseStatus, dur: Math.round(e.duration), size: e.transferSize });
  }
  return out;
})()`);
console.log('perf entries for session/list:', JSON.stringify(perf));
// 3) try to find the app's connection state — look for React fiber or known globals
const conn = await ev(`(function(){
  var out = { globals: [] };
  for (var k in window) {
    if (/dsh|module|connection|client/i.test(k) && !k.startsWith('on')) out.globals.push(k);
  }
  // look at the root fiber for memoized state containing session arrays
  try {
    var root = document.getElementById('root');
    var key = Object.keys(root).find(function(k){ return k.indexOf('__reactContainer') !== -1 || k.indexOf('__reactFiber') !== -1; });
    out.fiberKey = key || 'none';
  } catch (e) { out.fiberErr = e.message; }
  return out;
})()`);
console.log('app globals/fiber:', JSON.stringify(conn, null, 1));
// 4) wait 20s and see if rows appear on their own (lazy load delay?)
console.log('waiting 20s for lazy render…');
await sleep(20000);
const after = await ev(`(function(){
  var gs = document.querySelectorAll('[class*="_groupSection"]');
  var out = [];
  for (var i = 0; i < gs.length; i++) {
    var pr = gs[i].querySelector('[class*="_projectRow"]');
    var rows = gs[i].querySelectorAll('[class*="_sessionRow"]');
    var titles = [];
    for (var j = 0; j < Math.min(rows.length, 4); j++) titles.push((rows[j].textContent || '').trim().substring(0, 30));
    out.push({ expanded: pr ? pr.getAttribute('aria-expanded') : '?', rows: rows.length, titles: titles });
  }
  return out;
})()`);
console.log('after 20s:', JSON.stringify(after, null, 1));
cdp.close();
process.exit(0);
