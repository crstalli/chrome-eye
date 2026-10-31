#!/usr/bin/env node
// Diagnostic: patch window.fetch to log every app request URL + status (incl 4xx/5xx), watch 40s.
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
    if (txt.indexOf('FLOG') !== -1) logLines.push(txt.substring(0, 200));
  }
});
await cdp.send('Runtime.enable', {}, s);
// Patch fetch BEFORE any reload — but app already booted; patch now, then force a re-list via UI action.
const patch = await cdp.send('Runtime.evaluate', { expression: `
(function(){
  if (window.__flog) return 'already';
  window.__flog = true;
  var orig = window.fetch;
  window.fetch = function(input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '?';
    var method = (init && init.method) || (input && input.method) || 'GET';
    return orig.apply(this, arguments).then(function(resp) {
      console.log('FLOG ' + method + ' ' + url + ' -> ' + resp.status);
      return resp;
    }, function(err) {
      console.log('FLOG ' + method + ' ' + url + ' -> ERR ' + err.message);
      throw err;
    });
  };
  return 'patched';
})()
`, returnByValue: true }, s, 10000);
console.log('fetch patch:', patch.result.value);
// Trigger: click each project row (toggle expand) to make app do work
const click = await cdp.send('Runtime.evaluate', { expression: `
(function(){
  var prs = document.querySelectorAll('[class*="_projectRow"]');
  var out = [];
  for (var i = 0; i < prs.length; i++) { prs[i].click(); out.push('clicked ' + i); }
  return out.join(', ');
})()
`, returnByValue: true }, s, 10000);
console.log(click.result.value);
console.log('watching 40s…');
await sleep(40000);
console.log('FLOG lines (' + logLines.length + '):');
for (const l of logLines) console.log(l);
cdp.close();
process.exit(0);
