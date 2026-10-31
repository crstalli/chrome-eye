#!/usr/bin/env node
// Live verification of the composer-hook mechanisms, via CDP :9222.
// SAFETY: no real keypresses, no text is ever inserted into the live
// composer, no Enter is dispatched that could submit. The live-box test
// only runs if the composer is EMPTY (canSubmit() is then false → even a
// reaching Enter cannot submit). All listeners are removed in finally.
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
const ev = (expr) => cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  .then((r) => (r.exceptionDetails ? { __exception: r.exceptionDetails.exception && r.exceptionDetails.exception.description || 'exception' } : r.result.value));

const result = await ev(`(async () => {
  const out = { tests: {} };

  const findBox = () => {
    let c = document.querySelectorAll('div[data-composer-input="true"][contenteditable="true"]');
    if (!c.length) c = document.querySelectorAll('div[role="textbox"][contenteditable="true"]');
    for (const el of c) {
      const label = (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('data-placeholder') || '');
      if (/message/i.test(label)) return el;
    }
    for (const el of c) { const r = el.getBoundingClientRect(); if (r.width > 50 && r.height > 10) return el; }
    return null;
  };
  const findSend = () => document.querySelector('button[aria-label="Send message"]');
  const box = findBox();
  const send = findSend();
  out.selectors = {
    composerBox: !!box,
    boxTag: box ? box.tagName + '[data-composer-input=' + box.getAttribute('data-composer-input') + ']' : null,
    boxEmpty: box ? box.textContent.trim().length === 0 : null,
    sendButton: !!send,
    sendRect: send ? (() => { const r = send.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })() : null,
  };

  const mkEnter = () => new KeyboardEvent('keydown', {
    key: 'Enter', code: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false,
    altKey: false, repeat: false, bubbles: true, cancelable: true, composed: true
  });

  // ---- Test 1: propagation mechanism on a DETACHED node (always safe) ----
  {
    const d = document.createElement('div');
    d.setAttribute('contenteditable', 'true');
    d.style.cssText = 'position:fixed;left:-99999px;top:0;width:200px;height:40px;';
    document.body.appendChild(d);
    let targetFired = 0;
    const targetH = (e) => { targetFired++; };
    d.addEventListener('keydown', targetH); // target phase (no capture)
    let blocked = true;
    const capH = (e) => {
      if (e.key === 'Enter' && d.contains(e.target)) { e.preventDefault(); e.stopPropagation(); }
    };
    document.addEventListener('keydown', capH, true); // CAPTURE, like the hook
    d.dispatchEvent(mkEnter());
    blocked = targetFired === 0;
    document.removeEventListener('keydown', capH, true);
    d.dispatchEvent(mkEnter());
    const unblocked = targetFired === 1;
    d.removeEventListener('keydown', targetH);
    d.remove();
    out.tests.propagation = { blocked, unblocked, pass: blocked && unblocked };
  }

  // ---- Test 2: same mechanism on the LIVE box (only if it is empty) ----
  {
    if (!box || box.textContent.trim().length > 0) {
      out.tests.liveBox = { skipped: box ? 'box non-empty (safety: no live-box test)' : 'box missing' };
    } else {
      let targetFired = 0, defaultPreventedAfterUnblocked = null;
      const targetH = (e) => { targetFired++; defaultPreventedAfterUnblocked = e.defaultPrevented; };
      const capH = (e) => {
        if (e.key === 'Enter' && box.contains(e.target)) { e.preventDefault(); e.stopPropagation(); }
      };
      box.addEventListener('keydown', targetH);
      document.addEventListener('keydown', capH, true);
      box.dispatchEvent(mkEnter());
      const blocked = targetFired === 0;
      document.removeEventListener('keydown', capH, true);
      const ev2 = mkEnter();
      box.dispatchEvent(ev2);
      const unblocked = targetFired === 1;
      box.removeEventListener('keydown', targetH);
      out.tests.liveBox = {
        blocked, unblocked,
        appHandlerRan: unblocked && defaultPreventedAfterUnblocked === true,
        pass: blocked && unblocked,
      };
    }
  }

  // ---- Test 3: execCommand insertText on a DETACHED contenteditable ----
  {
    const d = document.createElement('div');
    d.setAttribute('contenteditable', 'true');
    d.style.cssText = 'position:fixed;left:-99999px;top:0;width:300px;height:80px;white-space:pre-wrap;';
    document.body.appendChild(d);
    let inputEvents = 0, inputTypes = [];
    d.addEventListener('input', (e) => { inputEvents++; inputTypes.push(e.inputType); });
    d.focus();
    let inserted = false;
    try { inserted = document.execCommand('insertText', false, 'hello\\nworld line2'); } catch (e) { inserted = 'ERR ' + e.message; }
    const html = d.innerHTML;
    const text = d.textContent;
    const hasBreak = /<br|<div|\\n/.test(html);
    d.remove();
    out.tests.insertText = {
      inserted,
      textAfter: text,
      htmlSnippet: html.slice(0, 160),
      hasBreak,
      inputEvents,
      inputTypes,
      pass: inserted === true && text.indexOf('hello') === 0 && text.indexOf('world line2') !== -1 && hasBreak && inputEvents >= 1,
    };
  }

  // ---- Test 4: structural send-button fallback chain (grow→scroll→card→root) ----
  {
    if (!box) { out.tests.structuralSend = { skipped: 'no box' }; }
    else {
      const root = box.parentElement && box.parentElement.parentElement && box.parentElement.parentElement.parentElement;
      let found = null;
      if (root) {
        const btns = root.querySelectorAll('button');
        for (let i = btns.length - 1; i >= 0; i--) {
          const r = btns[i].getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { found = btns[i]; break; }
        }
      }
      out.tests.structuralSend = {
        rootFound: !!root,
        fallbackIsSend: !!found && (found === send),
        pass: !!root && found === send,
      };
    }
  }

  return out;
})()`);

console.log(JSON.stringify(result, null, 2));
cdp.close();
