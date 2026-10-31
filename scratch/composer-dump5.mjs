#!/usr/bin/env node
// Phase 5: full composer region structure — ancestors + subtree of the
// role=textbox contenteditable, plus the send button location.
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

const dump = await ev(`(() => {
  const box = document.querySelector('div[role=textbox]');
  if (!box) return { error: 'no role=textbox' };
  function describe(el) {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      cls: (el.className || '').toString().slice(0, 90),
      role: el.getAttribute('role') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      ariaKeyshortcuts: el.getAttribute('aria-keyshortcuts') || undefined,
      contenteditable: el.getAttribute('contenteditable') || undefined,
      id: el.id || undefined,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  }
  function kids(el, depth) {
    return [...el.children].slice(0, 16).map((c) => {
      const d = describe(c);
      d.text = (c.innerText || '').slice(0, 30);
      d.svg = !!c.querySelector('svg');
      if (depth < 3) d.kids = kids(c, depth + 1);
      return d;
    });
  }
  // ancestors
  const ancestors = [];
  let node = box;
  for (let i = 0; i < 10 && node; i++) {
    ancestors.push({ level: i, ...describe(node), children: i === 0 ? null : [...node.children].map((c) => ({ tag: c.tagName.toLowerCase(), cls: (c.className || '').toString().slice(0, 60), svg: !!c.querySelector('svg'), text: (c.innerText || '').slice(0, 20) })) });
    node = node.parentElement;
  }
  // subtree of the composer box
  const subtree = { ...describe(box), text: (box.innerText || '').slice(0, 50), kids: kids(box, 0) };
  return { ancestors, subtree, html: box.parentElement.outerHTML.slice(0, 3000) };
})()`);
console.log(JSON.stringify(dump, null, 2));
cdp.close();
