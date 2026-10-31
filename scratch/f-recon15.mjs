#!/usr/bin/env node
// Diagnostic: full DOM tree of the workspace tree region (all descendants of role=tree), with tags+classes.
const BASE = 'http://127.0.0.1:9222';
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
  close() { try { this.ws.close(); } catch {} }
}
const ver = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(3000) });
const cdp = await Cdp.connect((await ver.json()).webSocketDebuggerUrl);
await cdp.send('Target.setDiscoverTargets', { discover: true });
const t = await cdp.send('Target.getTargets');
const iframe = t.targetInfos.find((x) => x.type === 'iframe' && x.url && x.url.indexOf('3081') !== -1);
const att = await cdp.send('Target.attachToTarget', { targetId: iframe.targetId, flatten: true });
const s = att.sessionId;
await cdp.send('Runtime.enable', {}, s);
const r = await cdp.send('Runtime.evaluate', { expression: `
(function(){
  var tree = document.querySelector('[role="tree"]');
  if (!tree) return 'NO TREE';
  var lines = [];
  function walk(el, depth) {
    if (lines.length > 300) return;
    var cls = el.className && el.className.baseVal !== undefined ? el.className.baseVal : (el.className || '');
    cls = String(cls).replace(/\\s+/g, ' ').substring(0, 60);
    var label = el.getAttribute('aria-label') || '';
    var txt = (el.childNodes.length === 1 && el.childNodes[0].nodeType === 3) ? '"' + el.textContent.substring(0, 24) + '"' : '';
    lines.push('  '.repeat(depth) + el.tagName.toLowerCase() + (cls ? '.' + cls : '') + (label ? ' aria="' + label + '"' : '') + txt);
    for (var c of el.children) walk(c, depth + 1);
  }
  walk(tree, 0);
  return lines.join('\\n');
})()
`, returnByValue: true }, s, 15000);
console.log(r.result.value);
cdp.close();
process.exit(0);
