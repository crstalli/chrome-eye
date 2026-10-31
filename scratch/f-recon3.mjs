#!/usr/bin/env node
// Diagnostic: raw HTML via bridge + full iframe DOM dump.
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
// 1) raw HTML through the bridge
const html = await fetch('http://127.0.0.1:3081/', { signal: AbortSignal.timeout(10000) }).then((r) => r.text());
console.log('=== raw HTML from :3081/ (' + html.length + ' chars) ===');
console.log(html.substring(0, 2500));
console.log('...[truncated]');
// 2) full iframe DOM
const cdp = await Cdp.connect(await browserWs());
await cdp.send('Target.setDiscoverTargets', { discover: true });
const t = await cdp.send('Target.getTargets');
const iframe = t.targetInfos.find((x) => x.type === 'iframe' && x.url && x.url.indexOf('3081') !== -1);
if (!iframe) { console.log('NO IFRAME'); process.exit(1); }
const att = await cdp.send('Target.attachToTarget', { targetId: iframe.targetId, flatten: true });
const s = att.sessionId;
await cdp.send('Runtime.enable', {}, s);
const r = await cdp.send('Runtime.evaluate', {
  expression: `(function(){
    var d = document.documentElement;
    return {
      htmlLen: d ? d.outerHTML.length : -1,
      scripts: Array.prototype.map.call(document.querySelectorAll('script[src]'), function(s){ return s.src; }),
      inlineScripts: document.querySelectorAll('script:not([src])').length,
      bodyHTML: document.body ? document.body.innerHTML.substring(0, 3000) : '(no body)'
    };
  })()`,
  returnByValue: true
}, s, 15000);
const info = r.result.value;
console.log('=== iframe DOM ===');
console.log('htmlLen:', info.htmlLen);
console.log('script srcs:', JSON.stringify(info.scripts, null, 1));
console.log('inline scripts:', info.inlineScripts);
console.log('body HTML (3000 chars):');
console.log(info.bodyHTML);
cdp.close();
process.exit(0);
