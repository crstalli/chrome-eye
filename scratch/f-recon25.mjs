#!/usr/bin/env node
// Diagnostic: capture ALL network responses at iframe boot (reload via iframe src), dump session/list + any gzip.
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
  send(method, params = {}, sessionId, timeoutMs = 30000) {
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
const fs = await import('node:fs');
const ver = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(3000) });
const cdp = await Cdp.connect((await ver.json()).webSocketDebuggerUrl);
await cdp.send('Target.setDiscoverTargets', { discover: true });
const t = await cdp.send('Target.getTargets');
const iframe = t.targetInfos.find((x) => x.type === 'iframe' && x.url && x.url.indexOf('3081') !== -1);
const att = await cdp.send('Target.attachToTarget', { targetId: iframe.targetId, flatten: true });
const s = att.sessionId;
const responses = [];
cdp.on((msg) => {
  if (!msg.method || !msg.params) return;
  if (msg.method === 'Network.responseReceived') {
    const p = msg.params;
    responses.push({ url: p.response.url, status: p.response.status, id: p.requestId });
  }
});
await cdp.send('Network.enable', {}, s);
await cdp.send('Runtime.enable', {}, s);
// Reload the iframe by setting its src to itself
const reload = await cdp.send('Runtime.evaluate', { expression: `
  (function(){
    var w = window;
    w.location.reload();
    return 'reloading';
  })()
`, returnByValue: true }, s, 10000);
console.log(reload.result.value);
await sleep(25000);
console.log('Total responses:', responses.length);
// Now fetch bodies for session/list and any that look interesting
for (const r of responses) {
  if (/session\/list|session\/create|dynamicCordis/.test(r.url)) {
    try {
      const body = await cdp.send('Network.getResponseBody', { requestId: r.id }, s, 10000);
      const buf = body.bodyBase64 ? Buffer.from(body.bodyBase64, 'base64') : Buffer.from(body.body, 'utf8');
      const label = r.url.replace(/[^a-z0-9]/gi, '_').substring(0, 40);
      fs.writeFileSync('/tmp/cap-' + label + '.bin', buf);
      console.log(r.url.substring(0, 60), 'status=' + r.status, 'bytes=' + buf.length, 'hex=' + buf.subarray(0, 4).toString('hex'));
    } catch (e) {
      console.log(r.url.substring(0, 60), 'body failed:', e.message);
    }
  }
}
cdp.close();
process.exit(0);
