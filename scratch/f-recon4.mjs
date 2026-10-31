#!/usr/bin/env node
// Diagnostic: app state inside the iframe — WS connection, boot flags, sidebar internals.
const BASE = 'http://127.0.0.1:9222';
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
  send(method, params = {}, sessionId, timeoutMs = 15000) {
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
await cdp.send('Network.enable', {}, s, 20000).catch(() => {});
const ev = async (expr, timeoutMs = 15000) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s, timeoutMs);
  if (r.exceptionDetails) return 'EVAL_ERR: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
};
// 1) patch WebSocket BEFORE we can reload — but we can't reload a frame.
//    Instead: check performance entries for WS + any visible connection status in the DOM.
const perf = await ev(`(function(){
  var entries = performance.getEntriesByType('resource');
  var interesting = [];
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e.initiatorType === 'xmlhttprequest' || e.name.indexOf('/api/') !== -1 || e.name.indexOf('/plugins/') !== -1) {
      interesting.push({ name: e.name.substring(0, 120), type: e.initiatorType, dur: Math.round(e.duration), status: e.responseStatus || 0 });
    }
  }
  return interesting.slice(0, 50);
})()`);
console.log('=== resource entries (api/plugins/xhr) ===');
console.log(JSON.stringify(perf, null, 1));
// 2) look for a connection-status indicator in the sidebar DOM (text like "offline", "connecting", error banners)
const statusTexts = await ev(`(function(){
  var sidebar = document.querySelector('[data-slot="sidebar"]');
  var root = sidebar || document.body;
  var out = [];
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  var n;
  while ((n = walker.nextNode())) {
    var t = (n.textContent || '').trim();
    if (t && t.length < 80) out.push(t);
  }
  return out.slice(0, 80);
})()`);
console.log('=== visible text in sidebar (first 80) ===');
console.log(JSON.stringify(statusTexts, null, 1));
// 3) check the group sections in detail — what's inside each (buttons? labels?)
const groups = await ev(`(function(){
  var gs = document.querySelectorAll('[class*="_groupSection"]');
  var out = [];
  for (var i = 0; i < gs.length; i++) {
    var g = gs[i];
    var btns = Array.prototype.map.call(g.querySelectorAll('button'), function(b){ return (b.getAttribute('aria-label') || b.textContent || '').trim().substring(0, 60); });
    out.push({ html: g.outerHTML.substring(0, 1200), buttons: btns });
  }
  return out;
})()`);
console.log('=== group section details ===');
console.log(JSON.stringify(groups, null, 1).substring(0, 6000));
cdp.close();
process.exit(0);
