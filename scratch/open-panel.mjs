#!/usr/bin/env node
// Open the chrome-eye side panel via the extension action (simulated user gesture).
// Polls for the SW target first so a lazy-activated worker is found.
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
        const { resolve, reject, timer } = cdp.pending.get(msg.id);
        clearTimeout(timer); cdp.pending.delete(msg.id);
        msg.error ? reject(new Error('CDP ' + msg.error.message)) : resolve(msg.result);
      }
    };
    return cdp;
  }
  send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}
async function listTargets() {
  try {
    const r = await fetch(`${BASE}/json/list`, { signal: AbortSignal.timeout(2000) });
    return await r.json();
  } catch { return []; }
}
// find SW target, retrying while it (re)activates
let swUrl = null;
for (let i = 0; i < 30 && !swUrl; i++) {
  const ts = await listTargets();
  const sw = ts.find((t) => t.type === 'service_worker' && t.url.indexOf('mlolgaoijponghgfnlcljlohnhlpnhkd') !== -1);
  if (sw) swUrl = sw.webSocketDebuggerUrl;
  else await sleep(500);
}
if (!swUrl) throw new Error('SW target not found');
const cdp = await Cdp.connect(swUrl);
await cdp.send('Runtime.enable');
const evalS = async (expr) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('eval exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
console.log('extension id:', await evalS(`chrome.runtime.id`));
console.log('action click result:', await evalS(`chrome.action.click().then(()=> 'CLICKED').catch(e => 'ERR:' + (e && e.message || e))`));
cdp.close();
// now look for the panel.html page target
let panel = null;
for (let i = 0; i < 40 && !panel; i++) {
  const ts = await listTargets();
  panel = ts.find((t) => t.type === 'page' && t.url && t.url.indexOf('panel.html') !== -1);
  if (panel) break;
  // re-check SW too in case it died
  const sw2 = ts.find((t) => t.type === 'service_worker' && t.url.indexOf('mlolgaoijponghgfnlcljlohnhlpnhkd') !== -1);
  if (i === 20) console.log('panel not yet visible; targets:', ts.map(t=>t.type+' '+t.url).join(' | '));
  await sleep(500);
}
if (panel) {
  console.log('PANEL TARGET FOUND:', panel.url);
  fs.writeFileSync('/mnt/f/ai/chrome-eye/scratch/panel-target.json', JSON.stringify(panel, null, 2));
  process.exit(0);
} else {
  console.log('PANEL TARGET NOT FOUND');
  process.exit(2);
}
