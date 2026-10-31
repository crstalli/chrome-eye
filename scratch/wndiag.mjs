#!/usr/bin/env node
// Live-probe the SW: can chrome.webNavigation.onCompleted.addListener work NOW?
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
const listTargets = () => cdp.send('Target.getTargets').then((r) => r.targetInfos);
const evIn = (sess, expr, timeoutMs = 20000) => cdp.send('Runtime.evaluate',
  { expression: expr, returnByValue: true, awaitPromise: true }, sess, timeoutMs)
  .then((r) => (r.exceptionDetails ? { __exception: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'exception' } : r.result.value));

// find SW (wake if needed via a panel page)
let swTarget = (await listTargets()).find((x) => x.type === 'service_worker' && x.url && x.url.indexOf(EXT_ID) !== -1) || null;
let panelTarget = null;
if (!swTarget) {
  panelTarget = (await cdp.send('Target.createTarget', { url: 'chrome-extension://' + EXT_ID + '/panel.html' })).targetId;
  const panelSess = (await cdp.send('Target.attachToTarget', { targetId: panelTarget, flatten: true })).sessionId;
  await cdp.send('Runtime.enable', {}, panelSess);
  for (let i = 0; i < 40; i++) {
    if ((await evIn(panelSess, 'document.readyState').catch(() => '')) === 'complete') break;
    await sleep(500);
  }
  for (let i = 0; i < 24 && !swTarget; i++) {
    swTarget = (await listTargets()).find((x) => x.type === 'service_worker' && x.url && x.url.indexOf(EXT_ID) !== -1) || null;
    if (!swTarget) {
      await evIn(panelSess, `chrome.runtime.sendMessage({ type: 'chrome-eye:panel-state' }).then(() => 1).catch(() => 0)`, 5000).catch(() => {});
      await sleep(500);
    }
  }
}
if (!swTarget) { console.log('SW not found'); process.exit(1); }
const swSess = (await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, swSess);

const probe = await evIn(swSess, `(async () => {
  const out = { hasApi: !!chrome.webNavigation };
  try {
    chrome.webNavigation.onCompleted.addListener(function () {}, { url: ['http://127.0.0.1:3081/*'] });
    out.addListenerSync = 'ok';
  } catch (e) { out.addListenerSync = 'threw: ' + e.message; }
  try {
    const frames = await chrome.webNavigation.getAllFrames({ urlFilter: 'http://127.0.0.1:3081/*' });
    out.getAllFrames = Array.isArray(frames) ? frames.length : 'n/a';
  } catch (e) { out.getAllFrames = 'threw: ' + e.message; }
  return out;
})()`);
console.log(JSON.stringify(probe, null, 2));

// also: which SW instance is this? check startup marker + stagedTabs
const state = await evIn(swSess, `({ staged: stagedTabs.length, panelOpen })`).catch(() => 'n/a');
console.log('SW state:', JSON.stringify(state));

if (panelTarget) await cdp.send('Target.closeTarget', { targetId: panelTarget }).catch(() => {});
cdp.close();
