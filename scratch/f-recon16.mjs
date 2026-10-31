#!/usr/bin/env node
// Diagnostic: click the "New session in cztl" button, watch for row creation / session creation.
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
  on(h) { this.handlers.push(h); }
  close() { try { this.ws.close(); } catch {} }
}
const ver = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(3000) });
const cdp = await Cdp.connect((await ver.json()).webSocketDebuggerUrl);
await cdp.send('Target.setDiscoverTargets', { discover: true });
const t = await cdp.send('Target.getTargets');
const iframe = t.targetInfos.find((x) => x.type === 'iframe' && x.url && x.url.indexOf('3081') !== -1);
const att = await cdp.send('Target.attachToTarget', { targetId: iframe.targetId, flatten: true });
const s = att.sessionId;
const logLines = [];
cdp.on((msg) => {
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params) {
    const txt = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    if (/FLOG|error|fail/i.test(txt)) logLines.push(txt.substring(0, 200));
  }
});
await cdp.send('Runtime.enable', {}, s);
const click = await cdp.send('Runtime.evaluate', { expression: `
(function(){
  var btns = document.querySelectorAll('button');
  for (var j = 0; j < btns.length; j++) {
    if ((btns[j].getAttribute('aria-label') || '') === 'New session in cztl') {
      btns[j].click();
      return 'clicked New session in cztl';
    }
  }
  return 'button not found';
})()
`, returnByValue: true }, s, 10000);
console.log(click.result.value);
for (const wait of [2000, 5000, 10000]) {
  await sleep(wait);
  const st = await cdp.send('Runtime.evaluate', { expression: `
    (function(){
      var tree = document.querySelector('[role="tree"]');
      var rows = tree ? tree.querySelectorAll('[class*="_sessionRow"]') : [];
      var gs = tree ? tree.querySelectorAll('[class*="_groupSection"]') : [];
      var g = [];
      for (var i = 0; i < gs.length; i++) {
        var pr = gs[i].querySelector('[class*="_projectRow"]');
        g.push({ expanded: pr ? pr.getAttribute('aria-expanded') : '?', kids: gs[i].children.length });
      }
      var sel = document.querySelector('[aria-selected="true"]');
      return { sessionRows: rows.length, groups: g, selected: sel ? (sel.textContent || '').substring(0, 30) : null };
    })()
  `, returnByValue: true }, s, 10000);
  console.log('+' + wait + 'ms:', JSON.stringify(st.result.value));
}
console.log('console:', JSON.stringify(logLines.slice(0, 15), null, 1));
cdp.close();
process.exit(0);
