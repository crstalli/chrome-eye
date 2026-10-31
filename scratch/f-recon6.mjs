#!/usr/bin/env node
// Diagnostic: expanded group DOM + try fetching session list in-frame.
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
  send(method, params = {}, sessionId, timeoutMs = 20000) {
    const id = ++this.id;
    const envelope = { id, method, params };
    if (sessionId) envelope.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(envelope));
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
const ev = async (expr, timeoutMs = 20000) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s, timeoutMs);
  if (r.exceptionDetails) return 'EVAL_ERR: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
};
// 1) full DOM of group 0 (expanded) — what does the app render inside it?
const g0 = await ev(`(function(){
  var g = document.querySelectorAll('[class*="_groupSection"]')[0];
  if (!g) return 'no group';
  var pr = g.querySelector('[class*="_projectRow"]');
  return {
    projectRowAriaExpanded: pr ? pr.getAttribute('aria-expanded') : '?',
    groupChildren: Array.prototype.map.call(g.children, function(c){ return c.tagName + '.' + (c.className || '').toString().substring(0, 40); }),
    groupInnerHTML: g.innerHTML.substring(0, 2500)
  };
})()`);
console.log('=== expanded group 0 DOM ===');
console.log(JSON.stringify(g0, null, 1).substring(0, 4000));
// 2) fetch session list in-frame and summarize
const list = await ev(`(async function(){
  try {
    var r = await fetch('/api/session/list', { headers: { 'accept': 'application/json' } });
    var j = await r.json();
    var out = { status: r.status, count: Array.isArray(j) ? j.length : (j.sessions ? j.sessions.length : 'unknown-shape') };
    if (Array.isArray(j) && j.length) out.first = { title: j[0].title, workspace: j[0].workspace, id: (j[0].id || '').substring(0, 20) };
    else if (j.sessions && j.sessions.length) out.first = { title: j.sessions[0].title, workspace: j.sessions[0].workspace, id: (j.sessions[0].id || '').substring(0, 20) };
    return out;
  } catch (e) { return 'FETCH_ERR ' + e.message; }
})()`);
console.log('=== /api/session/list in-frame ===');
console.log(JSON.stringify(list, null, 1));
// 3) dispatch click again on group 0 (toggle off?) — check state, then re-expand and wait 10s
console.log('re-click group 0 (toggle) then back…');
await ev(`(function(){ var pr = document.querySelectorAll('[class*="_groupSection"]')[0].querySelector('[class*="_projectRow"]'); pr.click(); return 'clicked'; })()`);
await sleep(1000);
await ev(`(function(){ var pr = document.querySelectorAll('[class*="_groupSection"]')[0].querySelector('[class*="_projectRow"]'); pr.click(); return 'clicked again'; })()`);
await sleep(8000);
console.log('after re-expand +8s:', await ev(`(function(){
  var gs = document.querySelectorAll('[class*="_groupSection"]');
  var out = [];
  for (var i = 0; i < gs.length; i++) {
    var pr = gs[i].querySelector('[class*="_projectRow"]');
    var rows = gs[i].querySelectorAll('[class*="_sessionRow"]');
    var titles = [];
    for (var j = 0; j < Math.min(rows.length, 5); j++) {
      var t = rows[j].textContent.trim();
      titles.push(t.substring(0, 40));
    }
    out.push({ expanded: pr ? pr.getAttribute('aria-expanded') : '?', rows: rows.length, titles: titles });
  }
  return out;
})()`));
cdp.close();
process.exit(0);
