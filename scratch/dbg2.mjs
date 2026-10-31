#!/usr/bin/env node
const BASE = 'http://127.0.0.1:9222';
const PAGE = '37ED7213580E5C0C1A3E4B5303C09438';
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const cdp = new Cdp(ws);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString()); } catch { return; }
      if (msg.id && cdp.pending.has(msg.id)) {
        const p = cdp.pending.get(msg.id); clearTimeout(p.timer); cdp.pending.delete(msg.id);
        msg.error ? p.reject(new Error('CDP ' + msg.error.message)) : p.resolve(msg.result);
      } else if (msg.method) cdp.events.push(msg);
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
const page = (await (await fetch(BASE + '/json')).json()).find((t) => t.id === PAGE);
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
await sleep(1000);
const st = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: `({ ready: document.readyState, hasRuntime: typeof chrome !== 'undefined' && !!chrome.runtime, id: (typeof chrome !== 'undefined' && chrome.runtime) ? chrome.runtime.id : null, bodyLen: document.body ? document.body.innerHTML.length : -1 })` }).then((r) => r.result.value);
console.log('panel state:', JSON.stringify(st));
const r = await cdp.send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: `chrome.runtime.sendMessage({ type: 'chrome-eye:panel-state' }).then((v) => 'got: ' + JSON.stringify(v)).catch((e) => 'ERR: ' + e.message)` }, undefined, 8000).then((x) => x.result.value).catch((e) => 'EVAL-ERR: ' + e.message);
console.log('panel-state result:', r);
await sleep(500);
console.log('events:', JSON.stringify(cdp.events.map((e) => e.method + (e.params && e.params.text ? ': ' + e.params.text.slice(0, 120) : '')), null, 1).slice(0, 2000));
cdp.close();
