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
const ver = await (await fetch(BASE + '/json/version')).json();
const cdp = await Cdp.connect(ver.webSocketDebuggerUrl);
const listTargets = () => cdp.send('Target.getTargets').then((r) => r.targetInfos);
let swTarget = (await listTargets()).find((x) => x.type === 'service_worker' && x.url && x.url.indexOf(EXT_ID) !== -1) || null;
let panelTarget = null;
if (!swTarget) {
  panelTarget = (await cdp.send('Target.createTarget', { url: 'chrome-extension://' + EXT_ID + '/panel.html' })).targetId;
  const ps = (await cdp.send('Target.attachToTarget', { targetId: panelTarget, flatten: true })).sessionId;
  await cdp.send('Runtime.enable', {}, ps);
  for (let i = 0; i < 24 && !swTarget; i++) {
    swTarget = (await listTargets()).find((x) => x.type === 'service_worker' && x.url && x.url.indexOf(EXT_ID) !== -1) || null;
    if (!swTarget) { await cdp.send('Runtime.evaluate', { expression: `chrome.runtime.sendMessage({ type: 'chrome-eye:panel-state' }).then(() => 1).catch(() => 0)` }, ps, 5000).catch(() => {}); await new Promise(r => setTimeout(r, 500)); }
  }
}
const swSess = (await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).sessionId;
const r = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
  const out = {};
  const t = (name, fn) => { try { fn(); out[name] = 'ok'; } catch (e) { out[name] = 'threw: ' + e.message; } };
  t('single_3081', () => chrome.webNavigation.onCompleted.addListener(function(){}, { url: ['http://127.0.0.1:3081/*'] }));
  t('single_3080', () => chrome.webNavigation.onCompleted.addListener(function(){}, { url: ['http://127.0.0.1:3080/*'] }));
  t('double_as_in_sw', () => chrome.webNavigation.onCompleted.addListener(function(){}, { url: ['http://127.0.0.1:3080/*', 'http://127.0.0.1:3081/*'] }));
  t('example_com', () => chrome.webNavigation.onCompleted.addListener(function(){}, { url: ['https://example.com/*'] }));
  t('star_star', () => chrome.webNavigation.onCompleted.addListener(function(){}, { url: ['*://*/*'] }));
  t('all_urls_token', () => chrome.webNavigation.onCompleted.addListener(function(){}, { url: ['<all_urls>'] }));
  return out;
})()` }, swSess).then(x => x.result.value).catch(e => ({ err: e.message }));
console.log(JSON.stringify(r, null, 2));
if (panelTarget) await cdp.send('Target.closeTarget', { targetId: panelTarget }).catch(() => {});
cdp.close();
