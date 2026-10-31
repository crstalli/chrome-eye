#!/usr/bin/env node
// Diagnostic: watch iframe app boot for 60s — console msgs, DOM growth, WS count.
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
      } else if (!msg.id) {
        for (const h of cdp.handlers) { try { h(msg); } catch {} }
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
console.log('iframe:', iframe.url);
const att = await cdp.send('Target.attachToTarget', { targetId: iframe.targetId, flatten: true });
const s = att.sessionId;
await cdp.send('Runtime.enable', {}, s);
await cdp.send('Log.enable', {}, s).catch(() => {});
await cdp.send('Page.enable', {}, s).catch(() => {});
const consoleMsgs = [];
const logMsgs = [];
const wsEvents = [];
cdp.on((msg) => {
  if (msg.method === 'Runtime.consoleAPICalled') {
    const txt = (msg.params.args || []).map((a) => a.value || a.description || '').join(' ').substring(0, 300);
    consoleMsgs.push('[' + msg.params.type + '] ' + txt);
  } else if (msg.method === 'Log.entryAdded') {
    logMsgs.push('[' + msg.params.entry.level + '] ' + (msg.params.entry.text || '').substring(0, 300));
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    consoleMsgs.push('[EXC] ' + ((d.exception && (d.exception.description || d.exception.value)) || d.text || '').substring(0, 300));
  }
});
const ev = async (expr, timeoutMs = 10000) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true }, s, timeoutMs);
  if (r.exceptionDetails) return 'EVAL_ERR: ' + (r.exceptionDetails.text || '');
  return r.result.value;
};
// Patch WebSocket to count connections (app's own WS traffic to remote.mux)
await ev(`(function(){
  if (window.__ceWsProbe) return 'already';
  window.__ceWsProbe = [];
  var OrigWS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    window.__ceWsProbe.push({ url: String(url), t: Date.now() });
    var ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
    var st = ws.onopen; ws.addEventListener('open', function(){ if (window.__ceWsProbe.length) window.__ceWsProbe[window.__ceWsProbe.length-1].open = true; });
    ws.addEventListener('close', function(ev){ if (window.__ceWsProbe.length) window.__ceWsProbe[window.__ceWsProbe.length-1].closeCode = ev.code; });
    ws.addEventListener('error', function(){ if (window.__ceWsProbe.length) window.__ceWsProbe[window.__ceWsProbe.length-1].error = true; });
    return ws;
  };
  window.WebSocket.prototype = OrigWS.prototype;
  window.WebSocket.CONNECTING = 0; window.WebSocket.OPEN = 1; window.WebSocket.CLOSING = 2; window.WebSocket.CLOSED = 3;
  return 'patched';
})()`);
console.log('WS patch result:', await ev('window.__ceWsProbe ? "patched" : "missing"'));
// Reload the iframe to capture full boot
console.log('reloading iframe…');
await cdp.send('Page.reload', { ignoreCache: true }, s, 20000).catch((e) => console.log('reload err', e.message));
for (let i = 0; i < 12; i++) {
  await sleep(5000);
  const snap = await ev(`(function(){
    var probe = window.__ceWsProbe || [];
    return {
      t: Date.now(),
      bodyLen: document.body ? document.body.innerText.length : -1,
      readyState: document.readyState,
      groups: document.querySelectorAll('[class*="_groupSection"]').length,
      rows: document.querySelectorAll('[class*="_sessionRow"]').length,
      ws: probe
    };
  })()`);
  if (typeof snap === 'string') { console.log('snap error:', snap); continue; }
  console.log('T+' + (i + 1) * 5 + 's bodyLen=' + snap.bodyLen + ' readyState=' + snap.readyState + ' groups=' + snap.groups + ' rows=' + snap.rows + ' ws=' + JSON.stringify(snap.ws));
  if (snap.rows > 0) { console.log('>>> rows appeared, stopping early'); break; }
}
console.log('=== console messages ===');
consoleMsgs.slice(0, 40).forEach((m) => console.log(m));
console.log('=== log entries ===');
logMsgs.slice(0, 40).forEach((m) => console.log(m));
cdp.close();
process.exit(0);
