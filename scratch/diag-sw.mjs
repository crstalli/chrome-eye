#!/usr/bin/env node
// scratch/diag-sw.mjs — trace the SW: capture console traffic + message
// types, stage a tab, then sample stagedTabs every second for 15 s to find
// the instant it clears.
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
      } else if (msg.method && cdp.onEvent) cdp.onEvent(msg);
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
let T0 = Date.now();
cdp.onEvent = (m) => {
  if (m.method === 'Runtime.consoleAPICalled' && T0) {
    const text = (m.params.args || []).map((a) => a.value !== undefined ? a.value : (a.description || a.type)).join(' ');
    console.log('[sw-console t=' + ((Date.now() - T0) / 1000).toFixed(1) + 's]', text.slice(0, 200));
  }
};
const listTargets = () => cdp.send('Target.getTargets').then((r) => r.targetInfos);
const evIn = (sess, expr, timeoutMs = 10000) => cdp.send('Runtime.evaluate',
  { expression: expr, returnByValue: true, awaitPromise: true }, sess, timeoutMs)
  .then((r) => {
    if (r.exceptionDetails) throw new Error('exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  });

// fresh panel + example.com
const pageTarget = (await cdp.send('Target.createTarget', { url: 'https://example.com/' })).targetId;
await sleep(2500);
const panelTarget = (await cdp.send('Target.createTarget', { url: 'chrome-extension://' + EXT_ID + '/panel.html' })).targetId;
await sleep(5000);

let swTarget = null;
for (let i = 0; i < 24 && !swTarget; i++) {
  swTarget = (await listTargets()).find((x) => x.type === 'service_worker' && x.url.includes(EXT_ID)) || null;
  if (!swTarget) await sleep(500);
}
const swSess = (await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, swSess);
console.log('SW attached:', swTarget.targetId);

const CHROME_TAB = await evIn(swSess, `new Promise((res) => chrome.tabs.query({ url: 'https://example.com/*' }, (ts) => res(ts[0] ? ts[0].id : null)))`);
console.log('staging tab', CHROME_TAB, 'at t=0');
T0 = Date.now();
const stageResp = await evIn(swSess, `new Promise((res) => chrome.runtime.sendMessage({ type: 'chrome-eye:stage-tab', tabId: ${CHROME_TAB} }, (r) => res(r)))`);
console.log('stage-tab response:', JSON.stringify(stageResp));

for (let i = 1; i <= 15; i++) {
  await sleep(1000);
  const s = await evIn(swSess, `JSON.stringify({ n: stagedTabs.length, ids: stagedTabs.map(function (t) { return t.id; }) })`).catch((e) => 'ERR:' + e.message.slice(0, 80));
  console.log('t+' + i + 's swStaged=' + s);
}

await cdp.send('Target.closeTarget', { targetId: pageTarget }).catch(() => {});
await cdp.send('Target.closeTarget', { targetId: panelTarget }).catch(() => {});
cdp.close();
process.exit(0);
