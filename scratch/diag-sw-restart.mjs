#!/usr/bin/env node
// scratch/diag-sw-restart.mjs — open the panel, then watch the SW target
// identity (targetId + performance.timeOrigin) every second for 30 s to see
// whether the MV3 service worker restarts in headless (losing volatile state).
const BASE = 'http://127.0.0.1:9222';
const EXT_ID = 'mlolgaoijponghgfnlcljlohnhlpnhkd';

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const cdp = new Cdp(ws);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString()); } catch { return; }
      if (msg.id && cdp.pending.has(msg.id)) {
        const p = cdp.pending.get(msg.id); clearTimeout(p.timer); cdp.pending.delete(msg.id);
        msg.error ? p.reject(new Error('CDP ' + msg.error.message)) : p.resolve(msg.result);
      }
    };
    return cdp;
  }
  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(payload));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ver = await (await fetch(BASE + '/json/version')).json();
const cdp = await Cdp.connect(ver.webSocketDebuggerUrl);
const listTargets = () => cdp.send('Target.getTargets').then((r) => r.targetInfos);
const evIn = (sess, expr, timeoutMs = 8000) => cdp.send('Runtime.evaluate',
  { expression: expr, returnByValue: true, awaitPromise: true }, sess, timeoutMs)
  .then((r) => {
    if (r.exceptionDetails) throw new Error('exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 200));
    return r.result.value;
  });

const panelTarget = (await cdp.send('Target.createTarget', { url: 'chrome-extension://' + EXT_ID + '/panel.html' })).targetId;
const T0 = Date.now();
for (let i = 0; i < 30; i++) {
  await sleep(1000);
  const sw = (await listTargets()).find((x) => x.type === 'service_worker' && x.url.includes(EXT_ID));
  if (!sw) { console.log('t+' + (i + 1) + 's: (no SW target)'); continue; }
  let origin = 'n/a';
  try {
    const sess = (await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, sess);
    origin = String(await evIn(sess, 'performance.timeOrigin'));
  } catch (e) { origin = 'attach-err:' + e.message.slice(0, 60); }
  console.log('t+' + (i + 1) + 's: targetId=' + sw.targetId + ' timeOrigin=' + origin);
}
await cdp.send('Target.closeTarget', { targetId: panelTarget }).catch(() => {});
cdp.close();
process.exit(0);
