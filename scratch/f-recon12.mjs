#!/usr/bin/env node
// Diagnostic: patch fetch+XMLHttpRequest, then click rows AND the "New Session" button, watch 30s.
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
    if (txt.indexOf('FLOG') !== -1) logLines.push(txt.substring(0, 220));
  }
});
await cdp.send('Runtime.enable', {}, s);
const patch = await cdp.send('Runtime.evaluate', { expression: `
(function(){
  var orig = window.fetch;
  window.fetch = function(input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '?';
    var method = (init && init.method) || 'GET';
    return orig.apply(this, arguments).then(function(resp) {
      console.log('FLOG FETCH ' + method + ' ' + url + ' -> ' + resp.status);
      return resp;
    }, function(err) {
      console.log('FLOG FETCH ' + method + ' ' + url + ' -> ERR ' + (err && err.message));
      throw err;
    });
  };
  var OrigXhr = window.XMLHttpRequest;
  window.XMLHttpRequest = function() {
    var xhr = new OrigXhr();
    var opened = null;
    var origOpen = xhr.open;
    xhr.open = function(m, u) { opened = m + ' ' + u; return origOpen.apply(this, arguments); };
    var origSend = xhr.send;
    xhr.send = function() {
      xhr.addEventListener('loadend', function() {
        console.log('FLOG XHR ' + (opened || '?') + ' -> ' + xhr.status);
      });
      return origSend.apply(this, arguments);
    };
    return xhr;
  };
  return 'patched both';
})()
`, returnByValue: true }, s, 10000);
console.log('patch:', patch.result.value);
// Click project rows + New Session button
const click = await cdp.send('Runtime.evaluate', { expression: `
(function(){
  var out = [];
  var prs = document.querySelectorAll('[class*="_projectRow"]');
  for (var i = 0; i < prs.length; i++) { prs[i].click(); out.push('pr' + i); }
  var ns = document.querySelector('[class*="_newSession"]') || document.querySelector('button[aria-label*="New Session"]');
  if (ns) { ns.click(); out.push('newSession'); } else {
    var btns = document.querySelectorAll('button');
    for (var j = 0; j < btns.length; j++) { if (/new session/i.test(btns[j].getAttribute('aria-label') || '')) { btns[j].click(); out.push('newSessionBtn'); break; } }
  }
  return out.join(', ');
})()
`, returnByValue: true }, s, 10000);
console.log('clicks:', click.result.value);
console.log('watching 30s…');
await sleep(30000);
console.log('FLOG (' + logLines.length + '):');
for (const l of logLines) console.log(l);
cdp.close();
process.exit(0);
