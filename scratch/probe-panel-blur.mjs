#!/usr/bin/env node
// Probe for the panel dropdown "click outside (main browser tab) closes it"
// fix. In headless Chrome, clicking the main tab = activating another tab,
// which blurs the panel window. We verify:
//   A. "Add tabs" dropdown: open -> blur (real tab activation; synthetic
//      blur as fallback) -> closed
//   B. "Add tabs" dropdown: regression — in-panel outside mousedown still
//      closes it; Escape still closes it
//   C. workspace-tree dropdown: open -> blur -> closed
// No composer input, no staged tabs: this only exercises panel.js UI state.
import fs from 'fs';
const BASE = 'http://127.0.0.1:9222';
const EXT_ID = 'mlolgaoijponghgfnlcljlohnhlpnhkd';

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
  send(method, params = {}, sessionId, timeoutMs = 30000) {
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
let failures = 0;
function check(name, cond, detail) {
  const status = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`  [${status}] ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
  return cond;
}

const ver = await (await fetch(BASE + '/json/version')).json();
const cdp = await Cdp.connect(ver.webSocketDebuggerUrl);
const listTargets = () => cdp.send('Target.getTargets').then((r) => r.targetInfos);
const evIn = (sess, expr, timeoutMs = 30000) => cdp.send('Runtime.evaluate',
  { expression: expr, returnByValue: true, awaitPromise: true }, sess, timeoutMs)
  .then((r) => (r.exceptionDetails
    ? { __exception: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'exception' }
    : r.result.value));

// ---------- fresh panel page (loads the edited panel.js from disk) ----------
console.log('1. opening panel.html');
const panelTarget = (await cdp.send('Target.createTarget', { url: 'chrome-extension://' + EXT_ID + '/panel.html' })).targetId;
const panelSess = (await cdp.send('Target.attachToTarget', { targetId: panelTarget, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, panelSess);
// Gate on a REAL panel element, not readyState: a fresh CDP target briefly
// serves the pre-commit empty document (also "complete"), where early evals
// run and clicks are lost.
let realDoc = false;
for (let i = 0; i < 60 && !realDoc; i++) {
  realDoc = !!(await evIn(panelSess, `document.getElementById('stage-row') !== null`).catch(() => false));
  if (!realDoc) await sleep(200);
}
check('panel page loaded (real document)', realDoc);
// spy that records REAL blur events (synthetic dispatches are flagged too,
// but the blur-firing path is what we assert on)
await evIn(panelSess, `
  window.__blurEvents = 0;
  window.__blurTrusted = 0;
  window.addEventListener('blur', (e) => {
    window.__blurEvents++;
    if (e.isTrusted) window.__blurTrusted++;
  });
  true
`);

// wake the SW so list-tabs answers (the dropdown needs it to render rows)
await evIn(panelSess, `new Promise((res) => {
  chrome.runtime.sendMessage({ type: 'chrome-eye:panel-state' }, (r) => { void chrome.runtime.lastError; res(r); });
  setTimeout(() => res(null), 4000);
})`).catch(() => {});

const tsOpen = () => evIn(panelSess, `document.querySelector('#ts-dropdown') && !document.querySelector('#ts-dropdown').hasAttribute('hidden')`);
const tsHidden = () => evIn(panelSess, `document.querySelector('#ts-dropdown') ? document.querySelector('#ts-dropdown').hasAttribute('hidden') : null`);
const wsOpen = () => evIn(panelSess, `document.querySelector('#ws-dropdown') && !document.querySelector('#ws-dropdown').hasAttribute('hidden')`);
const wsHidden = () => evIn(panelSess, `document.querySelector('#ws-dropdown') ? document.querySelector('#ws-dropdown').hasAttribute('hidden') : null`);

// ---------- A. "Add tabs" dropdown closes on window blur ----------
console.log('2. Add tabs: open -> blur -> closed');
await evIn(panelSess, `document.querySelector('#stage-row').click(); true`);
let open = false;
for (let i = 0; i < 30 && !open; i++) {
  open = !!(await tsOpen().catch(() => false));
  if (!open) await sleep(300);
}
check('Add tabs dropdown open', open);

// real blur: activate a scratch tab (the headless equivalent of clicking
// the main browser tab)
const scratchTarget = (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId;
const scratchSess = (await cdp.send('Target.attachToTarget', { targetId: scratchTarget, flatten: true })).sessionId;
await cdp.send('Page.bringToFront', {}, scratchSess);
await sleep(800);
const blursRealA = await evIn(panelSess, `window.__blurTrusted`).catch(() => -1);
let closedAfterRealBlur = !!(await tsHidden().catch(() => false));
let blurMode = 'real-tab-activation';
if (!closedAfterRealBlur) {
  // headless may not fire window blur on tab activation; exercise the
  // handler directly (same listener the real blur hits)
  blurMode = 'synthetic-blur-fallback';
  await cdp.send('Page.bringToFront', {}, panelSess);
  await sleep(400);
  await evIn(panelSess, `window.dispatchEvent(new Event('blur')); true`);
  await sleep(500);
  closedAfterRealBlur = !!(await tsHidden().catch(() => false));
}
check('Add tabs closed after window blur', closedAfterRealBlur,
  { mode: blurMode, realBlurEventObserved: blursRealA > 0 });

// ---------- B. regressions: outside mousedown + Escape still close it ----------
console.log('3. Add tabs: in-panel outside mousedown + Escape (regression)');
await cdp.send('Page.bringToFront', {}, panelSess);
await sleep(300);
await evIn(panelSess, `document.querySelector('#stage-row').click(); true`);
for (let i = 0; i < 20 && !(await tsOpen().catch(() => false)); i++) await sleep(300);
check('Add tabs reopened', !!(await tsOpen().catch(() => false)));
await evIn(panelSess, `document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`);
await sleep(400);
check('Add tabs closed by outside mousedown', !!(await tsHidden().catch(() => false)));

await evIn(panelSess, `document.querySelector('#stage-row').click(); true`);
for (let i = 0; i < 20 && !(await tsOpen().catch(() => false)); i++) await sleep(300);
check('Add tabs reopened (2)', !!(await tsOpen().catch(() => false)));
await evIn(panelSess, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
await sleep(400);
check('Add tabs closed by Escape', !!(await tsHidden().catch(() => false)));

// ---------- C. workspace-tree dropdown closes on blur ----------
console.log('4. workspace tree: open -> blur -> closed');
await evIn(panelSess, `document.querySelector('#ws-tree-btn').click(); true`);
let wsOpenNow = false;
for (let i = 0; i < 20 && !wsOpenNow; i++) {
  wsOpenNow = !!(await wsOpen().catch(() => false));
  if (!wsOpenNow) await sleep(300);
}
check('workspace dropdown open', wsOpenNow);
await cdp.send('Page.bringToFront', {}, scratchSess);
await sleep(800);
let wsClosed = !!(await wsHidden().catch(() => false));
let wsBlurMode = 'real-tab-activation';
if (!wsClosed) {
  wsBlurMode = 'synthetic-blur-fallback';
  await cdp.send('Page.bringToFront', {}, panelSess);
  await sleep(400);
  await evIn(panelSess, `window.dispatchEvent(new Event('blur')); true`);
  await sleep(500);
  wsClosed = !!(await wsHidden().catch(() => false));
}
check('workspace dropdown closed after window blur', wsClosed, { mode: wsBlurMode });

// ---------- cleanup ----------
await cdp.send('Target.closeTarget', { targetId: panelTarget }).catch(() => {});
await cdp.send('Target.closeTarget', { targetId: scratchTarget }).catch(() => {});
cdp.close();

console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
