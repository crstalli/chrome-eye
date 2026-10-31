#!/usr/bin/env node
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

const panel = (await cdp.send('Target.createTarget', { url: 'chrome-extension://' + EXT_ID + '/panel.html' })).targetId;
const ps = (await cdp.send('Target.attachToTarget', { targetId: panel, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, ps);
let sw = null;
for (let i = 0; i < 40; i++) {
  sw = (await listTargets()).find((x) => x.type === 'service_worker' && x.url && x.url.indexOf(EXT_ID) !== -1) || null;
  if (sw) break;
  await cdp.send('Runtime.evaluate', { expression: `chrome.runtime.sendMessage({ type: 'chrome-eye:panel-state' }).then(() => 1).catch(() => 0)` }, ps, 5000).catch(() => {});
  await sleep(500);
}
if (!sw) { console.log('FATAL: SW did not start'); process.exit(1); }
console.log('SW target:', sw.targetId);
const swSess = (await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, swSess);
await sleep(1500);
const check = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: `({ hookUrlMatch: typeof hookUrlMatch, onHookNavCompleted: typeof onHookNavCompleted, staged: stagedTabs.length, panelOpen })` }, swSess).then((r) => r.result.value).catch((e) => ({ err: e.message }));
console.log('new SW code check:', JSON.stringify(check));
const warns = cdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'warning').map((e) => e.params.args.map((a) => a.value || a.description).join(' ')).slice(0, 10);
const logs = cdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'log').map((e) => e.params.args.map((a) => a.value || a.description).join(' ')).slice(0, 10);
console.log('SW logs:', JSON.stringify(logs, null, 1));
console.log('SW warnings:', JSON.stringify(warns, null, 1));
await cdp.send('Target.closeTarget', { targetId: panel }).catch(() => {});
cdp.close();
