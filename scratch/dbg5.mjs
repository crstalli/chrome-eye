#!/usr/bin/env node
import fs from 'fs';
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
const panel = (await cdp.send('Target.createTarget', { url: 'chrome-extension://' + EXT_ID + '/panel.html' })).targetId;
const ps = (await cdp.send('Target.attachToTarget', { targetId: panel, flatten: true })).sessionId;
await cdp.send('Page.enable', {}, ps);
await cdp.send('Runtime.enable', {}, ps);
// wait for the :3081 iframe to commit + render
let iframeOk = false;
for (let i = 0; i < 30; i++) {
  const infos = (await cdp.send('Target.getTargets')).targetInfos;
  const f = infos.find((t) => t.type === 'iframe' && t.url && t.url.indexOf('127.0.0.1:3081') !== -1);
  if (f) {
    const fs2 = (await cdp.send('Target.attachToTarget', { targetId: f.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, fs2).catch(() => {});
    const st = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: 'document.readyState' }, fs2, 5000).then((r) => r.result.value).catch(() => null);
    if (st === 'complete') { iframeOk = true; break; }
  }
  await sleep(500);
}
console.log('iframe ready:', iframeOk);
await sleep(1500);
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, ps).catch((e) => { console.log('err:', e.message); return null; });
if (shot && shot.data) { fs.writeFileSync('/mnt/f/ai/chrome-eye/scratch/panel-shot-probe.png', Buffer.from(shot.data, 'base64')); console.log('saved', fs.statSync('/mnt/f/ai/chrome-eye/scratch/panel-shot-probe.png').size, 'bytes'); }
await cdp.send('Target.closeTarget', { targetId: panel }).catch(() => {});
cdp.close();
