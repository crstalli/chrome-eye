#!/usr/bin/env node
// Diagnostic: does clicking the _projectRow (treeitem) expand the group and render session rows?
const BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
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
      }
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
const ev = async (expr, timeoutMs = 15000) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, s, timeoutMs);
  if (r.exceptionDetails) return 'EVAL_ERR: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
  return r.result.value;
};
console.log('before:', await ev(`(function(){
  var gs = document.querySelectorAll('[class*="_groupSection"]');
  var out = [];
  for (var i = 0; i < gs.length; i++) {
    var pr = gs[i].querySelector('[class*="_projectRow"]');
    out.push({ expanded: pr ? pr.getAttribute('aria-expanded') : '?', rows: gs[i].querySelectorAll('[class*="_sessionRow"]').length });
  }
  return out;
})()`));
// Click the projectRow of group 0
const clicked = await ev(`(function(){
  var g = document.querySelector('[class*="_groupSection"]');
  if (!g) return 'no group';
  var pr = g.querySelector('[class*="_projectRow"]');
  if (!pr) return 'no projectRow';
  pr.click();
  return 'clicked projectRow, aria-expanded was ' + pr.getAttribute('aria-expanded');
})()`);
console.log('click result:', clicked);
await sleep(2000);
console.log('after 2s:', await ev(`(function(){
  var gs = document.querySelectorAll('[class*="_groupSection"]');
  var out = [];
  for (var i = 0; i < gs.length; i++) {
    var pr = gs[i].querySelector('[class*="_projectRow"]');
    var rows = gs[i].querySelectorAll('[class*="_sessionRow"]');
    var titles = [];
    for (var j = 0; j < Math.min(rows.length, 6); j++) {
      var t = rows[j].querySelector('[class*="_title"]');
      titles.push(t ? t.textContent.trim() : '(no title)');
    }
    out.push({ expanded: pr ? pr.getAttribute('aria-expanded') : '?', rows: rows.length, overflow: !!gs[i].querySelector('[class*="_sessionOverflowButton"]'), titles: titles });
  }
  return out;
})()`));
await sleep(3000);
console.log('after 5s:', await ev(`(function(){
  var gs = document.querySelectorAll('[class*="_groupSection"]');
  var out = [];
  for (var i = 0; i < gs.length; i++) {
    var pr = gs[i].querySelector('[class*="_projectRow"]');
    var rows = gs[i].querySelectorAll('[class*="_sessionRow"]');
    out.push({ expanded: pr ? pr.getAttribute('aria-expanded') : '?', rows: rows.length });
  }
  return out;
})()`));
// Also test double-click (some tree UIs use dblclick to expand)
console.log('double-click test on group 1…');
await ev(`(function(){
  var gs = document.querySelectorAll('[class*="_groupSection"]');
  if (gs.length < 2) return 'only ' + gs.length + ' groups';
  var pr = gs[1].querySelector('[class*="_projectRow"]');
  if (!pr) return 'no projectRow';
  pr.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }));
  return 'dblclicked group 1';
})()`);
await sleep(2000);
console.log('after dblclick:', await ev(`(function(){
  var gs = document.querySelectorAll('[class*="_groupSection"]');
  var out = [];
  for (var i = 0; i < gs.length; i++) {
    var pr = gs[i].querySelector('[class*="_projectRow"]');
    out.push({ expanded: pr ? pr.getAttribute('aria-expanded') : '?', rows: gs[i].querySelectorAll('[class*="_sessionRow"]').length });
  }
  return out;
})()`));
cdp.close();
process.exit(0);
