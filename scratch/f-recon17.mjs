#!/usr/bin/env node
// Diagnostic: capture the RAW response bytes of dynamicCordisRunner/inventory via CDP Network.
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
const respIds = new Map(); // requestId -> {url, headers, body}
cdp.on((msg) => {
  if (msg.method === 'Network.responseReceived' && msg.params) {
    const p = msg.params;
    if (/dynamicCordisRunner|session\/list|session\/create/.test(p.response.url)) {
      respIds.set(p.requestId, { url: p.response.url, status: p.response.status, headers: p.response.headers, size: p.response.headers['content-length'] });
      cdp.send('Network.getResponseBody', { requestId: p.requestId }, s, 10000).then((r) => {
        const rec = respIds.get(p.requestId);
        rec.bodyBase64 = r.bodyBase64 ? r.bodyBase64.substring(0, 400) : r.body.substring(0, 400);
        rec.isBase64 = !!r.bodyBase64;
        console.log('CAPTURED', p.response.url, 'status=' + p.response.status, 'headers=', JSON.stringify(p.response.headers).substring(0, 300));
        console.log('  body head (b64=' + rec.isBase64 + '):', rec.bodyBase64.substring(0, 120));
        if (rec.isBase64) {
          const buf = Buffer.from(rec.bodyBase64, 'base64');
          console.log('  raw bytes head:', JSON.stringify(buf.subarray(0, 24)));
        }
      }).catch((e) => console.log('  getResponseBody failed:', e.message));
    }
  }
});
await cdp.send('Network.enable', {}, s);
// Trigger a new session create to fire the requests
const click = await cdp.send('Runtime.evaluate', { expression: `
(function(){
  var btns = document.querySelectorAll('button');
  for (var j = 0; j < btns.length; j++) {
    if ((btns[j].getAttribute('aria-label') || '') === 'New session in cztl') { btns[j].click(); return 'clicked'; }
  }
  return 'not found';
})()
`, returnByValue: true }, s, 10000);
console.log(click.result.value);
await sleep(15000);
cdp.close();
process.exit(0);
