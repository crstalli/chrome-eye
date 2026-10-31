#!/usr/bin/env node
// Live-DOM composer investigation (Task J6 prep). Connects CDP to the
// headless Chrome already pointed at http://127.0.0.1:3081/ and dumps the
// composer subtree: the single-line <input>, its wrap span, the send
// button, and the surrounding structure — enough to design a robust
// structural selector for composer-hook.js.
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
if (!page) { console.error('no :3081 page target', targets.map((t) => t.type + ' ' + t.url)); process.exit(1); }
const cdp = await Cdp.connect(page.webSocketDebuggerUrl);

const ev = (expr) => cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false })
  .then((r) => (r.exceptionDetails ? { __exception: r.exceptionDetails.exception && r.exceptionDetails.exception.description || 'exception' } : r.result.value));

// Wait for the composer input to exist (React app boots in ~2-5s).
let input = null;
for (let i = 0; i < 30; i++) {
  const found = await ev(`(() => {
    const inputs = [...document.querySelectorAll('input')].filter(el => el.offsetParent !== null);
    return inputs.length ? inputs.map(el => el.className).join(',') : null;
  })()`);
  if (found) { console.log('visible inputs after ' + (i + 1) + ' polls:', found); break; }
  await sleep(1000);
}

// Dump the full structure: every visible input + ancestor chain (6 up) with
// tag/id/class/aria/role/placeholder, and each ancestor's children summary.
const dump = await ev(`(() => {
  function describe(el) {
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      cls: el.className && typeof el.className === 'string' ? el.className : undefined,
      role: el.getAttribute && el.getAttribute('role') || undefined,
      aria: el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('aria-expanded') && 'aria-expanded=' + el.getAttribute('aria-expanded')) || undefined,
      placeholder: el.getAttribute && el.getAttribute('placeholder') || undefined,
      type: el.getAttribute && el.type || undefined,
      disabled: el.disabled === true ? true : undefined,
      rect: el.getBoundingClientRect ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : undefined,
    };
  }
  function childrenSummary(el) {
    return [...el.children].slice(0, 12).map((c) => ({
      tag: c.tagName.toLowerCase(),
      cls: c.className && typeof c.className === 'string' ? c.className.slice(0, 60) : undefined,
      text: (c.innerText || '').slice(0, 30),
      hasSvg: !!c.querySelector('svg'),
      hasInput: !!c.querySelector('input'),
    }));
  }
  const out = [];
  for (const el of [...document.querySelectorAll('input')].filter((e) => e.offsetParent !== null)) {
    const chain = [];
    let node = el;
    for (let i = 0; i < 7 && node; i++) {
      const d = describe(node);
      if (i === 0) d.children = null; else d.children = childrenSummary(node);
      chain.push(d);
      node = node.parentElement;
    }
    out.push({ input: describe(el), chain });
  }
  return { inputCount: out.length, inputs: out, docTitle: document.title, url: location.href };
})()`);

console.log(JSON.stringify(dump, null, 2));
cdp.close();
