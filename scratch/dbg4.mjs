#!/usr/bin/env node
const BASE = 'http://127.0.0.1:9222';
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
// 1) test the regex in isolation (same V8 as the script)
const reTest = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
  const sample = '\\u{1F5C1} 1';
  const r1 = /\\u{1F5C1} 1/.test(sample);
  const cps = Array.from(sample).map((c) => c.codePointAt(0).toString(16));
  return { r1, cps, sampleLen: sample.length };
})()` }).then((r) => r.result.value).catch((e) => ({ err: e.message }));
console.log('regex isolation:', JSON.stringify(reTest));
// 2) find GUI iframe target
const infos = (await cdp.send('Target.getTargets')).targetInfos;
const gui = infos.find((t) => t.url === 'http://127.0.0.1:3081/');
console.log('gui target:', gui && { type: gui.type, id: gui.targetId, title: gui.title });
if (!gui) { cdp.close(); process.exit(0); }
const sess = (await cdp.send('Target.attachToTarget', { targetId: gui.targetId, flatten: true })).sessionId;
await cdp.send('Page.enable', {}, sess).catch((e) => console.log('Page.enable err:', e.message));
await sleep(800);
// 3) button codepoints in the real DOM
const btn = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
  const btns = Array.from(document.querySelectorAll('button'));
  const b = btns.find((x) => /^\\d+ staged pages? — attached to your next prompt/.test(x.title || ''));
  if (!b) return { found: false };
  const t = b.textContent;
  return { found: true, len: t.length, cps: Array.from(t).map((c) => c.codePointAt(0).toString(16)) };
})()` }, sess).then((r) => r.result.value);
console.log('button codepoints:', JSON.stringify(btn));
// 4) screenshot with error surfaced
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sess).then((r) => ({ ok: true, size: r.data.length })).catch((e) => ({ ok: false, err: e.message }));
console.log('screenshot:', JSON.stringify(shot));
cdp.close();
