#!/usr/bin/env node
// Diagnostic: capture RAW response of /api/session/list at boot via top-level page reload.
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
let t = await cdp.send('Target.getTargets');
// Use the TOP-LEVEL page (the panel.html), not the iframe
let page = t.targetInfos.find((x) => x.type === 'page' && x.url && x.url.indexOf('3081') !== -1);
if (!page) page = t.targetInfos.find((x) => x.type === 'page');
console.log('using target:', page.url.substring(0, 80));
const att = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
const s = att.sessionId;
let done = false;
let captured = 0;
cdp.on((msg) => {
  if (!msg.method || !msg.params) return;
  if (msg.method === 'Network.responseReceived') {
    const p = msg.params;
    if (/session\/list/.test(p.response.url)) {
      captured++;
      cdp.send('Network.getResponseBody', { requestId: p.requestId }, s, 15000).then((r) => {
        const body = r.bodyBase64 ? Buffer.from(r.bodyBase64, 'base64') : Buffer.from(r.body, 'utf8');
        fs.writeFileSync('/tmp/session-list-raw-' + captured + '.bin', body);
        console.log('session/list #' + captured + ': status=' + p.response.status, 'bytes=' + body.length);
        console.log('  hex:', body.subarray(0, 16).toString('hex'));
        console.log('  isGzip:', body[0] === 0x1f && body[1] === 0x8b);
        if (!body[0] === 0x1f && body[1] !== 0x8b) {
          console.log('  text head:', JSON.stringify(body.subarray(0, 300).toString('utf8')));
        }
      }).catch((e) => console.log('  getResponseBody failed:', e.message));
    }
  }
});
await cdp.send('Network.enable', {}, s);
await cdp.send('Page.enable', {}, s);
// Reload the top-level page
await cdp.send('Page.reload', { ignoreCache: true }, s, 15000).catch((e) => console.log('reload failed:', e.message));
await sleep(25000);
console.log('captured', captured, 'session/list responses');
process.exit(0);
