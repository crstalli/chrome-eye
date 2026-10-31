#!/usr/bin/env node
// Phase 3: dump the sidebar list area HTML + click a real session row.
const BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const html = await ev(`(() => {
  const area = document.querySelector('.bhn1Oq_listArea');
  return area ? area.innerHTML.slice(0, 4000) : 'no listArea';
})()`);
console.log('=== listArea HTML ===');
console.log(html);

// Click the first session-like row: an element inside listArea whose
// text starts with "Llama" (deepest such element).
const clicked = await ev(`(() => {
  const area = document.querySelector('.bhn1Oq_listArea');
  if (!area) return 'no area';
  const cands = [...area.querySelectorAll('*')].filter((el) => {
    const t = (el.textContent || '').trim();
    return t.startsWith('Llama') && el.offsetParent !== null;
  });
  if (!cands.length) return 'no llama row; texts=' + area.innerText.replace(/\\n/g, '|');
  const el = cands[cands.length - 1];
  el.click();
  return 'clicked ' + el.tagName + '.' + (el.className || '').toString().slice(0, 50);
})()`);
console.log('click:', clicked);
await sleep(5000);

const dump = await ev(`(() => {
  function describe(el) {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      cls: el.className && typeof el.className === 'string' ? el.className : undefined,
      role: el.getAttribute && el.getAttribute('role') || undefined,
      ariaLabel: el.getAttribute && el.getAttribute('aria-label') || undefined,
      placeholder: el.getAttribute && el.getAttribute('placeholder') || undefined,
      type: el.type || undefined,
      value: el.tagName === 'INPUT' ? el.value : undefined,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  }
  function kids(el) {
    return [...el.children].slice(0, 14).map((c) => ({
      tag: c.tagName.toLowerCase(),
      cls: c.className && typeof c.className === 'string' ? c.className.slice(0, 70) : undefined,
      text: (c.innerText || '').slice(0, 25),
      svg: !!c.querySelector('svg'),
      input: !!c.querySelector('input'),
    }));
  }
  const out = [];
  for (const el of [...document.querySelectorAll('input')].filter((e) => e.offsetParent !== null)) {
    const chain = [];
    let node = el;
    for (let i = 0; i < 9 && node; i++) {
      const d = describe(node);
      if (i > 0) d.children = kids(node);
      chain.push(d);
      node = node.parentElement;
    }
    out.push(chain);
  }
  return { count: out.length, chains: out, title: document.title, url: location.href };
})()`);
console.log('=== post-click inputs ===');
console.log(JSON.stringify(dump, null, 2));
cdp.close();
