#!/usr/bin/env node
// Diagnostic: instrument WebSocket + fetch + XHR, watch 20s for any network activity.
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
    if (txt.indexOf('FLOG') !== -1) logLines.push(txt.substring(0, 240));
  }
});
await cdp.send('Runtime.enable', {}, s);
const patch = await cdp.send('Runtime.evaluate', { expression: `
(function(){
  var OrigWS = window.WebSocket;
  window.WebSocket = function(url, proto) {
    console.log('FLOG WS OPEN ' + url + ' proto=' + (proto || 'none'));
    var ws = new OrigWS(url, proto);
    var origSend = ws.send;
    ws.send = function(data) {
      var len = (typeof data === 'string') ? data.length : (data && data.byteLength) || 0;
      var head = (typeof data === 'string') ? data.substring(0, 120) : 'binary';
      console.log('FLOG WS SEND len=' + len + ' head=' + head);
      return origSend.call(this, data);
    };
    ws.addEventListener('open', function() { console.log('FLOG WS OPENED ' + url); });
    ws.addEventListener('message', function(ev) {
      var d = ev.data;
      var len = (typeof d === 'string') ? d.length : (d && d.byteLength) || 0;
      console.log('FLOG WS MSG len=' + len + ' head=' + ((typeof d === 'string') ? d.substring(0, 120) : 'binary'));
    });
    ws.addEventListener('close', function(e) { console.log('FLOG WS CLOSE ' + e.code + ' ' + e.reason); });
    return ws;
  };
  window.WebSocket.prototype = OrigWS.prototype;
  var orig = window.fetch;
  window.fetch = function(input, init) {
    var url = (typeof input === 'string') ? input : (input && input.url) || '?';
    console.log('FLOG FETCH ' + ((init && init.method) || 'GET') + ' ' + url);
    return orig.apply(this, arguments).then(function(r) { console.log('FLOG FETCH ' + url + ' -> ' + r.status); return r; });
  };
  return 'patched WS+fetch';
})()
`, returnByValue: true }, s, 10000);
console.log('patch:', patch.result.value);
const click = await cdp.send('Runtime.evaluate', { expression: `
(function(){
  var prs = document.querySelectorAll('[class*="_projectRow"]');
  for (var i = 0; i < prs.length; i++) { prs[i].click(); }
  var ns = document.querySelector('button');
  var btns = document.querySelectorAll('button');
  for (var j = 0; j < btns.length; j++) { if (/new session/i.test(btns[j].getAttribute('aria-label') || '')) { btns[j].click(); break; } }
  return 'clicked ' + prs.length + ' rows';
})()
`, returnByValue: true }, s, 10000);
console.log(click.result.value);
await sleep(20000);
console.log('FLOG (' + logLines.length + '):');
for (const l of logLines) console.log(l);
cdp.close();
process.exit(0);
