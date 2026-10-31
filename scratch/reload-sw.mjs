#!/usr/bin/env node
// Force the extension to reload from disk (SW script cache bust), verify new code runs.
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
const findSw = async () => (await listTargets()).find((x) => x.type === 'service_worker' && x.url && x.url.indexOf(EXT_ID) !== -1) || null;

let sw = await findSw();
if (!sw) {
  console.log('no SW running; waking via panel page first');
  const wp = (await cdp.send('Target.createTarget', { url: 'chrome-extension://' + EXT_ID + '/panel.html' })).targetId;
  const ps = (await cdp.send('Target.attachToTarget', { targetId: wp, flatten: true })).sessionId;
  await cdp.send('Runtime.enable', {}, ps);
  for (let i = 0; i < 40; i++) {
    sw = await findSw();
    if (sw) break;
    await cdp.send('Runtime.evaluate', { expression: `chrome.runtime.sendMessage({ type: 'chrome-eye:panel-state' }).then(() => 1).catch(() => 0)` }, ps, 5000).catch(() => {});
    await sleep(500);
  }
}
if (!sw) { console.log('FATAL: no SW to reload'); process.exit(1); }
console.log('old SW target:', sw.targetId);

const swSess = (await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
console.log('issuing chrome.runtime.reload()...');
await cdp.send('Runtime.evaluate', { expression: 'chrome.runtime.reload()' }, swSess, 5000).catch((e) => console.log('eval returned (expected disconnect):', e.message.slice(0, 80)));
await sleep(4000);

// close stale extension pages (dead after reload) and open a fresh panel page to wake the new SW
const stale = (await listTargets()).filter((x) => x.url && x.url.indexOf(EXT_ID) !== -1 && x.type !== 'service_worker');
for (const t of stale) await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
const panel = (await cdp.send('Target.createTarget', { url: 'chrome-extension://' + EXT_ID + '/panel.html' })).targetId;
const ps = (await cdp.send('Target.attachToTarget', { targetId: panel, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, ps);

let newSw = null;
for (let i = 0; i < 60; i++) {
  newSw = await findSw();
  if (newSw && newSw.targetId !== sw.targetId) break;
  await cdp.send('Runtime.evaluate', { expression: `chrome.runtime.sendMessage({ type: 'chrome-eye:panel-state' }).then(() => 1).catch(() => 0)` }, ps, 5000).catch(() => {});
  await sleep(500);
}
if (!newSw) { console.log('FATAL: no new SW appeared after reload'); process.exit(1); }
console.log('new SW target:', newSw.targetId);

const nSess = (await cdp.send('Target.attachToTarget', { targetId: newSw.targetId, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, nSess);
await sleep(1500);
const check = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: `({ hookUrlMatch: typeof hookUrlMatch, onHookNavCompleted: typeof onHookNavCompleted, staged: stagedTabs.length })` }, nSess).then((r) => r.result.value).catch((e) => ({ err: e.message }));
console.log('new SW code check:', JSON.stringify(check));

// capture startup console: re-enable won't replay, so just verify no error state via behavior:
// add a filtered listener (should throw in headless) vs unfiltered (should work)
const ev = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
  const out = {};
  try { chrome.webNavigation.onCompleted.addListener(function(){}, { url: ['http://127.0.0.1:3081/*'] }); out.filtered = 'ok'; } catch (e) { out.filtered = 'threw: ' + e.message; }
  try { chrome.webNavigation.onCompleted.addListener(function(){}); out.unfiltered = 'ok'; } catch (e) { out.unfiltered = 'threw: ' + e.message; }
  return out;
})()` }, nSess).then((r) => r.result.value).catch((e) => ({ err: e.message }));
console.log('listener probe (new SW):', JSON.stringify(ev));
await cdp.send('Target.closeTarget', { targetId: panel }).catch(() => {});
cdp.close();
