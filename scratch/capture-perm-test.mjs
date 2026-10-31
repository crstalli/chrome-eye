#!/usr/bin/env node
// Phase-1 root-cause probe: does the CURRENT manifest grant the extension
// host access to arbitrary http(s) pages (the user's failing capture)?
//
//   A  chrome.permissions.getAll()          -> what host access is GRANTED
//   B  tabs.sendMessage(capture) on example.com -> declared content script
//      auto-injected on an external page? (receiving end exists?)
//   C  scripting.executeScript(func) on example.com -> programmatic injection
//   D  scripting.executeScript(files:['content.js']) -> the EXACT failing call
//      from sw.js captureTab() fallback (sw.js:65-66)
//
// No extension code is modified. SW is driven through a browser-level CDP
// session (J5 wake method: chrome.runtime.sendMessage from the panel page
// wakes the idle SW via runtime.onMessage).
const BASE = 'http://127.0.0.1:9222';
const EXT_ID = 'mlolgaoijponghgfnlcljlohnhlpnhkd';

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

const ver = await (await fetch(BASE + '/json/version')).json();
const cdp = await Cdp.connect(ver.webSocketDebuggerUrl);
const listTargets = () => cdp.send('Target.getTargets').then((r) => r.targetInfos);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evIn = (sess, expr) => cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sess)
  .then((r) => (r.exceptionDetails ? { __exception: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'exception' } : r.result.value));

// ---- 1: fresh panel page (wakes SW via runtime.onMessage) ----
const P = (await cdp.send('Target.createTarget', { url: 'chrome-extension://' + EXT_ID + '/panel.html' })).targetId;
const ps = (await cdp.send('Target.attachToTarget', { targetId: P, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, ps);
for (let i = 0; i < 40 && (await evIn(ps, 'document.readyState').catch(() => '')) !== 'complete'; i++) await sleep(500);

// ---- 2: wake the SW (J5 method) ----
let swTarget = null;
for (let i = 0; i < 24; i++) {
  swTarget = (await listTargets()).find((x) => x.type === 'service_worker' && x.url && x.url.indexOf(EXT_ID) !== -1) || null;
  if (swTarget) break;
  await evIn(ps, `chrome.runtime.sendMessage({ type: 'chrome-eye:panel-state' }).then((r) => 1).catch(() => 0)`).catch(() => {});
  await sleep(500);
}
if (!swTarget) { console.error('SW target never appeared (wake failed)'); process.exit(1); }
const sw = (await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, sw);
const swEval = (expr) => evIn(sw, expr);
console.error('SW attached:', swTarget.url.slice(0, 70));

const out = {};

// ---- A: granted host permissions ----
out.A_granted = await swEval(`(async () => {
  const perms = await chrome.permissions.getAll();
  return { origins: perms.origins };
})()`);

// ---- open example.com, wait for load complete ----
const tab = await swEval(`(async () => {
  const t = await chrome.tabs.create({ url: 'https://example.com/', active: false });
  for (let i = 0; i < 60; i++) {
    const cur = await chrome.tabs.get(t.id);
    if (cur.status === 'complete') return { id: cur.id, url: cur.url, title: cur.title };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { id: t.id, timeout: true };
})()`);
out.tab = tab;
if (!tab || tab.timeout) { console.error('tab did not load', tab); process.exit(2); }
const TAB = tab.id;

// ---- B: declared content script receiving end on external page? ----
out.B_recvEnd = await swEval(`(async () => {
  try {
    const resp = await chrome.tabs.sendMessage(${TAB}, { type: 'chrome-eye:capture' });
    return { ok: true, respKeys: resp ? Object.keys(resp) : null, title: resp && resp.title, textLen: resp && (resp.text || '').length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
})()`);

// ---- C: programmatic injection (func) on external page ----
out.C_funcInject = await swEval(`(async () => {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: ${TAB} },
      func: () => ({ title: document.title, href: location.href })
    });
    return { ok: true, value: res && res[0] && res[0].result };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
})()`);

// ---- D: the EXACT failing call from sw.js:65-66 (files: content.js) ----
out.D_fileInject = await swEval(`(async () => {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: ${TAB} },
      files: ['content.js']
    });
    return { ok: true, frameCount: (res || []).length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
})()`);

cdp.close();
console.log(JSON.stringify(out, null, 2));
