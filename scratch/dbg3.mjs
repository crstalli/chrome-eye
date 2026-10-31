#!/usr/bin/env node
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
  send(method, params = {}, sessionId, timeoutMs = 20000) {
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
// fresh options.html page
const t = await cdp.send('Target.createTarget', { url: 'chrome-extension://' + EXT_ID + '/options.html' });
const ps = (await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, ps);
await sleep(2000);
const st = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: `({ ready: document.readyState, hasRuntime: typeof chrome !== 'undefined' && !!chrome.runtime, id: (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime.id : null, title: document.title })` }, ps).then((r) => r.result.value).catch((e) => ({ err: e.message }));
console.log('options.html state:', JSON.stringify(st));
await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
cdp.close();
