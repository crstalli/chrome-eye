#!/usr/bin/env node
// Diagnostic: watch the iframe's network + console for 401s and app errors.
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
const events = [];
cdp.on((msg) => {
  if (msg.method === 'Network.responseReceived' && msg.params) {
    const p = msg.params;
    if (p.response.status >= 400 || p.response.status === 401) {
      events.push({ kind: 'resp4xx', status: p.response.status, url: p.response.url, t: Date.now() });
    }
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params) {
    const txt = (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').substring(0, 160);
    if (/error|401|unauthorized|failed|fail/i.test(txt)) events.push({ kind: 'console', text: txt, t: Date.now() });
  }
  if (msg.method === 'Runtime.exceptionThrown' && msg.params) {
    const d = msg.params.exceptionDetails;
    events.push({ kind: 'exception', text: (d.exception && d.exception.description) || d.text, t: Date.now() });
  }
});
await cdp.send('Network.enable', {}, s);
await cdp.send('Runtime.enable', {}, s);
// Trigger activity: click a project row and wait, so the app would try to load sessions
const click = await cdp.send('Runtime.evaluate', { expression: `
  (function(){
    var prs = document.querySelectorAll('[class*="_projectRow"]');
    if (!prs.length) return 'no rows';
    var before = prs[1] ? prs[1].getAttribute('aria-expanded') : null;
    if (prs[1]) prs[1].click();
    return 'clicked group1, was ' + before;
  })()
`, returnByValue: true }, s, 10000);
console.log('click:', click.result.value);
console.log('watching 25s…');
await sleep(25000);
console.log('events (' + events.length + '):');
for (const e of events.slice(0, 40)) console.log(JSON.stringify(e));
// also check the new group's row state
const st = await cdp.send('Runtime.evaluate', { expression: `
  (function(){
    var gs = document.querySelectorAll('[class*="_groupSection"]');
    var out = [];
    for (var i = 0; i < gs.length; i++) {
      var pr = gs[i].querySelector('[class*="_projectRow"]');
      var rows = gs[i].querySelectorAll('[class*="_sessionRow"]');
      out.push({ expanded: pr ? pr.getAttribute('aria-expanded') : '?', rows: rows.length });
    }
    return out;
  })()
`, returnByValue: true }, s, 10000);
console.log('groups after:', JSON.stringify(st.result.value));
cdp.close();
process.exit(0);
