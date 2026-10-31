#!/usr/bin/env node
// Phase 2: enter a session (click "New Session" in the sidebar), then dump
// every visible input's ancestor chain to locate the composer.
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

// Click an EXISTING session row ("Llama.cpp") — no new session created.
const clicked = await ev(`(() => {
  const cands = [...document.querySelectorAll('button, [role=button], div, span, a')]
    .filter((el) => el.offsetParent !== null && (el.textContent || '').trim() === 'Llama.cpp');
  if (!cands.length) return 'not-found';
  const el = cands[cands.length - 1]; // deepest/smallest element with that text
  el.click();
  return 'clicked:' + el.tagName + '.' + (el.className || '').toString().slice(0, 40);
})()`);
console.log('click:', clicked);
await sleep(4000);

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
    for (let i = 0; i < 8 && node; i++) {
      const d = describe(node);
      if (i > 0) d.children = kids(node);
      chain.push(d);
      node = node.parentElement;
    }
    out.push(chain);
  }
  return { count: out.length, chains: out, title: document.title };
})()`);
console.log(JSON.stringify(dump, null, 2));
cdp.close();
