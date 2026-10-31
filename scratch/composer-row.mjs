#!/usr/bin/env node
// Dump the composer toolbar row (.uV2eYG_row) subtree + all buttons in the
// composer seat, to find the send control and a safe anchor for the hook button.
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

const out = await ev(`(() => {
  const row = document.querySelector('.uV2eYG_row');
  const dumpNode = (el, depth, maxDepth) => {
    if (!el || depth > maxDepth) return null;
    const r = el.getBoundingClientRect();
    const o = {
      tag: el.tagName,
      cls: typeof el.className === 'string' ? el.className : '',
      role: el.getAttribute('role') || undefined,
      aria: el.getAttribute('aria-label') || undefined,
      title: el.getAttribute('title') || undefined,
      text: (el.childElementCount === 0 ? el.textContent : '').slice(0, 60) || undefined,
      svg: el.tagName === 'svg' ? (el.getAttribute('aria-label') || el.innerHTML.slice(0, 80)) : undefined,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
    const kids = [];
    for (const c of el.children) {
      const k = dumpNode(c, depth + 1, maxDepth);
      if (k) kids.push(k);
    }
    if (kids.length) o.children = kids;
    return o;
  };
  const seat = document.querySelector('.wSkVaW_composerSeat');
  const buttons = [];
  if (seat) {
    for (const b of seat.querySelectorAll('button, [role="button"]')) {
      const r = b.getBoundingClientRect();
      buttons.push({
        cls: (typeof b.className === 'string' ? b.className : '').slice(0, 80),
        aria: b.getAttribute('aria-label'),
        title: b.getAttribute('title'),
        text: b.textContent.slice(0, 40),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      });
    }
  }
  // editor root details
  const box = document.querySelector('div[role="textbox"][contenteditable]');
  const boxInfo = box ? {
    outerHTML: box.outerHTML.slice(0, 400),
    innerHTML: box.innerHTML.slice(0, 200),
    parentChain: (() => {
      const c = [];
      let p = box.parentElement;
      for (let i = 0; i < 3 && p; i++) { c.push((typeof p.className === 'string' ? p.className : p.tagName).slice(0, 60)); p = p.parentElement; }
      return c;
    })(),
  } : null;
  return { row: row ? dumpNode(row, 0, 4) : 'row not found', buttons, boxInfo };
})()`);
console.log(JSON.stringify(out, null, 2));
cdp.close();
