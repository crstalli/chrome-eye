#!/usr/bin/env node
// Diagnostic: capture FULL raw body of /api/session/create response (no truncation), hex dump.
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
const fs = await import('node:fs');
const ver = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(3000) });
const cdp = await Cdp.connect((await ver.json()).webSocketDebuggerUrl);
await cdp.send('Target.setDiscoverTargets', { discover: true });
const t = await cdp.send('Target.getTargets');
const iframe = t.targetInfos.find((x) => x.type === 'iframe' && x.url && x.url.indexOf('3081') !== -1);
const att = await cdp.send('Target.attachToTarget', { targetId: iframe.targetId, flatten: true });
const s = att.sessionId;
let done = false;
cdp.on((msg) => {
  if (done || !msg.method || msg.method !== 'Network.responseReceived' || !msg.params) return;
  const p = msg.params;
  if (!/session\/create/.test(p.response.url)) return;
  done = true;
  cdp.send('Network.getResponseBody', { requestId: p.requestId }, s, 10000).then((r) => {
    const body = r.bodyBase64 ? Buffer.from(r.bodyBase64, 'base64') : Buffer.from(r.body, 'utf8');
    fs.writeFileSync('/tmp/session-create-raw.bin', body);
    console.log('saved', body.length, 'bytes to /tmp/session-create-raw.bin');
    console.log('hex head:', body.subarray(0, 32).toString('hex'));
    console.log('text head:', JSON.stringify(body.subarray(0, 200).toString('utf8')));
    process.exit(0);
  }).catch((e) => { console.log('failed:', e.message); process.exit(1); });
});
await cdp.send('Network.enable', {}, s);
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
await sleep(12000);
process.exit(0);
