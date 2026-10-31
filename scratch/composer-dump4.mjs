#!/usr/bin/env node
// Phase 4: main content area — find the composer region by class prefix and
// structural shape, including HIDDEN inputs/areas.
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
  const out = {};
  // 1) every input/textarea in the document, visible or not
  out.allInputs = [...document.querySelectorAll('input, textarea, [contenteditable=true]')].map((el) => {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      visible: el.offsetParent !== null,
      cls: (el.className || '').toString().slice(0, 60),
      placeholder: el.placeholder || el.getAttribute('placeholder') || undefined,
      role: el.getAttribute('role') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  });
  // 2) elements whose class mentions the known composer module prefix
  out.composerModule = [...document.querySelectorAll('[class*="1g6ru"]')].map((el) => {
    const r = el.getBoundingClientRect();
    return { tag: el.tagName.toLowerCase(), cls: (el.className || '').toString().slice(0, 80), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
  });
  // 3) span > input structural candidates (visible)
  out.spanInput = [...document.querySelectorAll('span > input')].filter((el) => el.offsetParent !== null).map((el) => {
    const s = el.parentElement;
    const r = el.getBoundingClientRect();
    return {
      inputCls: (el.className || '').toString().slice(0, 60),
      parentCls: (s.className || '').toString().slice(0, 80),
      parentChildCount: s.children.length,
      grandparentCls: (s.parentElement && s.parentElement.className || '').toString().slice(0, 80),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    };
  });
  // 4) main content area: biggest non-sidebar container
  out.mainRegions = [...document.querySelectorAll('div')].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 400 && r.height > 400 && r.x > 280;
  }).slice(0, 8).map((el) => {
    const r = el.getBoundingClientRect();
    return { cls: (el.className || '').toString().slice(0, 60), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, text: (el.innerText || '').slice(0, 120).replace(/\\n/g, ' | ') };
  });
  return out;
})()`);
console.log(JSON.stringify(dump, null, 2));
cdp.close();
