#!/usr/bin/env node
// scratch/diag-final.mjs — the real staging path (panel context, not SW
// self-message), with full SW identity tracking: targetId, timeOrigin,
// stagedTabs length, plus Target crash/destroyed events.
const BASE = 'http://127.0.0.1:9222';
const EXT_ID = 'mlolgaoijponghgfnlcljlohnhlpnhkd';

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
    if (r.exceptionDetails) throw new Error('exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 250));
    return r.result.value;
  });

const T0 = Date.now();
const st = (label, extra) => console.log('t+' + ((Date.now() - T0) / 1000).toFixed(1) + 's ' + label + (extra ? ' ' + extra : ''));
cdp.events.forEach(() => {});
const drainEvents = () => {
  const evs = cdp.events.splice(0);
  for (const e of evs) {
    if (e.method === 'Target.targetCrashed') st('!! targetCrashed', JSON.stringify(e.params));
    else if (e.method === 'Target.targetDestroyed') st('!! targetDestroyed', JSON.stringify(e.params));
    else if (e.method === 'Target.detachedFromTarget') st('detached', JSON.stringify(e.params).slice(0, 120));
    else if (e.method === 'Target.targetInfoChanged') {
      const t = e.params.targetInfo;
      if (t && t.url && t.url.includes(EXT_ID)) st('targetInfoChanged', t.type + ' ' + t.targetId + ' ' + t.url.slice(0, 60));
    }
  }
};

await cdp.send('Target.setDiscoverTargets', { discover: true });

// example.com tab (the page to stage)
const pageTarget = (await cdp.send('Target.createTarget', { url: 'https://example.com/' })).targetId;
await sleep(2500);
// panel as a tab (the real side-panel content)
const panelTarget = (await cdp.send('Target.createTarget', { url: 'chrome-extension://' + EXT_ID + '/panel.html' })).targetId;
await sleep(4000);

let sw = null;
for (let i = 0; i < 24 && !sw; i++) {
  drainEvents();
  sw = (await listTargets()).find((x) => x.type === 'service_worker' && x.url.includes(EXT_ID)) || null;
  if (!sw) await sleep(500);
}
st('SW found', sw.targetId);

// panel session for the REAL staging path
const panelSess = (await cdp.send('Target.attachToTarget', { targetId: panelTarget, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, panelSess);

const TAB_ID = await evIn(panelSess, `new Promise((res) => chrome.tabs.query({ url: 'https://example.com/*' }, (ts) => res(ts[0] ? ts[0].id : null)))`).catch((e) => 'ERR:' + e.message.slice(0, 80));
st('tab to stage', String(TAB_ID));

// STAGE from the panel context (same as the real UI)
const stageResp = await evIn(panelSess, `new Promise((res) => chrome.runtime.sendMessage({ type: 'chrome-eye:stage-tab', tabId: ${TAB_ID} }, (r) => res(r)))`);
st('stage-tab response', JSON.stringify(stageResp));

for (let i = 1; i <= 20; i++) {
  await sleep(1000);
  drainEvents();
  const cur = (await listTargets()).find((x) => x.type === 'service_worker' && x.url.includes(EXT_ID));
  if (!cur) { st('sample: (no SW target)'); continue; }
  const identityChanged = cur.targetId !== sw.targetId;
  let origin = 'n/a', staged = 'n/a';
  try {
    const sess = (await cdp.send('Target.attachToTarget', { targetId: cur.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, sess);
    origin = String(await evIn(sess, 'performance.timeOrigin'));
    staged = String(await evIn(sess, 'stagedTabs.length'));
  } catch (e) { origin = 'err:' + e.message.slice(0, 60); }
  st('sample', 'targetId=' + cur.targetId + (identityChanged ? ' (CHANGED!)' : '') + ' timeOrigin=' + origin + ' stagedTabs=' + staged);
}

await cdp.send('Target.closeTarget', { targetId: pageTarget }).catch(() => {});
await cdp.send('Target.closeTarget', { targetId: panelTarget }).catch(() => {});
cdp.close();
process.exit(0);
