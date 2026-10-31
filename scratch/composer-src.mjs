#!/usr/bin/env node
// Find the live plugin bundle that renders the composer (class uV2eYG) and
// extract its Enter/keydown + text-input handling source.
const BASE = 'http://127.0.0.1:9222';

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const cdp = new Cdp(ws);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString()); } catch { return; }
      if (msg.id && cdp.pending.has(msg.id)) {
        const p = cdp.pending.get(msg.id); clearTimeout(p.timer); cdp.pending.delete(msg.id);
        msg.error ? p.reject(new Error('CDP ' + msg.error.message)) : p.resolve(msg.result);
      } else if (!msg.id) { for (const h of cdp.handlers) { try { h(msg); } catch {} } }
    };
    return cdp;
  }
  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const targets = await (await fetch(BASE + '/json')).json();
const page = targets.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:3081'));
if (!page) { console.error('no :3081 page target'); process.exit(1); }
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
const ev = (expr) => cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })
  .then((r) => (r.exceptionDetails ? { __exception: r.exceptionDetails.exception && r.exceptionDetails.exception.description || 'exception' } : r.result.value));

// Enumerate loaded script URLs (performance entries) and find the one(s)
// containing the composer class hash.
const urls = await ev(`(() => performance.getEntriesByType('resource')
  .map((r) => r.name)
  .filter((u) => u.includes('/plugins/') || u.endsWith('.js'))
  .join('\\n'))()`);
console.log('--- loaded scripts ---');
console.log(urls);

// Fetch each candidate in-page and search for uV2eYG / keydown / Enter.
const found = await ev(`(async () => {
  const urls = performance.getEntriesByType('resource').map((r) => r.name)
    .filter((u) => u.includes('/plugins/') || u.includes('assets/'));
  const out = [];
  for (const u of urls) {
    let txt;
    try { txt = await (await fetch(u)).text(); } catch (e) { continue; }
    if (!txt.includes('uV2eYG')) continue;
    const idx = txt.indexOf('uV2eYG');
    // gather context around keydown/Enter handling
    const ctx = [];
    const re = /keydown|Enter|isComposing|preventDefault|contentEditable|innerHTML|textContent|placeholder/g;
    let m;
    while ((m = re.exec(txt)) !== null) {
      ctx.push(txt.slice(Math.max(0, m.index - 160), m.index + 200));
      if (ctx.length > 40) break;
    }
    out.push({ url: u, len: txt.length, firstIdx: idx, firstCtx: txt.slice(Math.max(0, idx - 300), idx + 400), ctx });
  }
  return out;
})()`);
console.log('--- matches ---');
console.log(JSON.stringify(found, null, 2));
cdp.close();
