#!/usr/bin/env node
// Panel driver: attach to SW via browser-level CDP, click the extension
// action to open the side panel, then return the panel's target info.
// SW is lazy-activated; we nudge it by connecting to its /json/list ws URL
// the moment it appears, and attach through the browser endpoint for the
// action click.
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
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
      }
    };
    return cdp;
  }
  send(method, params = {}, sessionId, timeoutMs = 15000) {
    const id = ++this.id;
    const envelope = { id, method, params };
    if (sessionId) envelope.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(envelope));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}
async function browserWs() {
  const r = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(3000) });
  return (await r.json()).webSocketDebuggerUrl;
}
async function listTargets() {
  try {
    const r = await fetch(`${BASE}/json/list`, { signal: AbortSignal.timeout(3000) });
    return await r.json();
  } catch { return []; }
}
const cdp = await Cdp.connect(await browserWs());
await cdp.send('Target.setDiscoverTargets', { discover: true });

// 1. Nudge the SW to activate: poll /json/list; as soon as it appears, open a
//    direct connection (which keeps it alive) and issue a harmless eval.
let swDirect = null;
for (let i = 0; i < 40 && !swDirect; i++) {
  const ts = await listTargets();
  const sw = ts.find((t) => t.type === 'service_worker' && t.url.indexOf('mlolgaoijponghgfnlcljlohnhlpnhkd') !== -1);
  if (sw) {
    try {
      swDirect = await Cdp.connect(sw.webSocketDebuggerUrl);
      await swDirect.send('Runtime.enable');
      const r = await swDirect.send('Runtime.evaluate', { expression: 'chrome.runtime.id', returnByValue: true });
      if (r.result && r.result.value) break;
    } catch (e) { swDirect = null; }
  }
  if (!swDirect) await sleep(500);
}
if (!swDirect) {
  console.log('NO SW after 20s');
  process.exit(1);
}
console.log('SW activated:', await swDirect.send('Runtime.evaluate', { expression: 'chrome.runtime.id', returnByValue: true }).then((r) => r.result.value));

// 2. Now the SW target is in the browser's target list; attach via browser endpoint
const t = await cdp.send('Target.getTargets');
const swInfo = t.targetInfos.find((x) => x.type === 'service_worker' && x.url.indexOf('mlolgaoijponghgfnlcljlohnhlpnhkd') !== -1);
if (!swInfo) {
  console.log('SW not in browser target list; targets:', t.targetInfos.map((x) => x.type + ' ' + x.url).join(' | '));
  swDirect.close();
  process.exit(1);
}
const swRes = await cdp.send('Target.attachToTarget', { targetId: swInfo.targetId, flatten: true });
const swSess = swRes.sessionId;
await cdp.send('Runtime.enable', {}, swSess);

// 3. Click the action (openPanelOnActionClick:true → side panel opens)
const clickResult = await cdp.send('Runtime.evaluate', {
  expression: `chrome.action.click().then(()=>'CLICKED').catch(e=>'ERR:'+(e&&e.message||e))`,
  returnByValue: true, awaitPromise: true,
}, swSess, 20000).then((r) => {
  if (r.exceptionDetails) throw new Error('click exc: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
});
console.log('action click:', clickResult);

// 4. Poll for the panel.html page target
let panel = null;
for (let i = 0; i < 60 && !panel; i++) {
  const t2 = await cdp.send('Target.getTargets');
  panel = t2.targetInfos.find((x) => x.url && x.url.indexOf('panel.html') !== -1);
  if (i === 40) console.log('targets:', t2.targetInfos.map((x) => x.type + ' ' + x.url).join(' | '));
  if (!panel) await sleep(400);
}
if (!panel) { console.log('PANEL NOT FOUND'); swDirect.close(); cdp.close(); process.exit(2); }
console.log('PANEL TARGET:', panel.url, 'targetId=' + panel.targetId);
fs.writeFileSync('/mnt/f/ai/chrome-eye/scratch/panel-target.json', JSON.stringify(panel, null, 2));
swDirect.close();
cdp.close();
process.exit(0);
