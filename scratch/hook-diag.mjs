#!/usr/bin/env node
// Diagnose: is the composer hook present in the panel's :3081 GUI iframe?
//  - open a panel.html tab, watch SW console (Runtime.consoleAPICalled)
//  - find the :3081 iframe target
//  - enumerate its execution contexts, find the ISOLATED one
//  - eval window.__ceComposerHook + armed state there
//  - stage a tab, watch the SW console again (panel-state round trips)
import fs from 'fs';
const BASE = 'http://127.0.0.1:9222';
const EXT_ID = 'mlolgaoijponghgfnlcljlohnhlpnhkd';

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const cdp = new Cdp(ws);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString()); } catch { return; }
      if (msg.id && cdp.pending.has(msg.id)) {
        const p = cdp.pending.get(msg.id); clearTimeout(p.timer); cdp.pending.delete(msg.id);
        msg.error ? p.reject(new Error('CDP ' + msg.error.message)) : p.resolve(msg.result);
      } else if (msg.method) { cdp.events.push(msg); }
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

const ver = await (await fetch(BASE + '/json/version')).json();
const cdp = await Cdp.connect(ver.webSocketDebuggerUrl);
const listTargets = () => cdp.send('Target.getTargets').then((r) => r.targetInfos);
const evIn = (sess, expr, timeoutMs = 20000) => cdp.send('Runtime.evaluate',
  { expression: expr, returnByValue: true, awaitPromise: true }, sess, timeoutMs)
  .then((r) => (r.exceptionDetails ? { __exception: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'exception' } : r.result.value));

// SW console watcher
let swSess = null;
const swLogs = [];
const onEvent = (e) => {
  if (e.method === 'Runtime.consoleAPICalled' && e.sessionId === swSess) {
    const text = (e.params.args || []).map((a) => a.value !== undefined ? a.value : (a.description || a.type)).join(' ');
    swLogs.push(`[${new Date().toISOString().slice(11, 19)}] ${text}`);
  }
};
cdp.ws.onmessage = ((orig) => (m) => {
  let msg; try { msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString()); } catch { return; }
  if (msg.id && cdp.pending.has(msg.id)) {
    const p = cdp.pending.get(msg.id); clearTimeout(p.timer); cdp.pending.delete(msg.id);
    msg.error ? p.reject(new Error('CDP ' + msg.error.message)) : p.resolve(msg.result);
  } else if (msg.method) { onEvent(msg); }
})(cdp.ws.onmessage);

// open panel page
console.log('opening panel page...');
const panelTarget = (await cdp.send('Target.createTarget', { url: 'chrome-extension://' + EXT_ID + '/panel.html' })).targetId;
const panelSess = (await cdp.send('Target.attachToTarget', { targetId: panelTarget, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, panelSess);
for (let i = 0; i < 40 && (await evIn(panelSess, 'document.readyState').catch(() => '')) !== 'complete'; i++) await sleep(500);

// wake + attach SW
let swTarget = null;
for (let i = 0; i < 24 && !swTarget; i++) {
  swTarget = (await listTargets()).find((x) => x.type === 'service_worker' && x.url && x.url.indexOf(EXT_ID) !== -1) || null;
  if (!swTarget) {
    await evIn(panelSess, `chrome.runtime.sendMessage({ type: 'chrome-eye:panel-state' }).then(() => 1).catch(() => 0)`, 5000).catch(() => {});
    await sleep(500);
  }
}
console.log('SW:', swTarget ? 'found' : 'NOT FOUND');
swSess = (await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, swSess);
await sleep(2000);
console.log('\n--- SW console so far ---');
swLogs.forEach((l) => console.log(' ', l));
swLogs.length = 0;

// find :3081 iframe targets (there may be several — report all)
await sleep(3000); // give the iframe time to start loading
let iframes = [];
for (let i = 0; i < 20; i++) {
  iframes = (await listTargets()).filter((x) => x.type === 'iframe' && x.url && x.url.indexOf('127.0.0.1:3081') !== -1);
  if (iframes.length) break;
  await sleep(500);
}
console.log('\n:3081 iframe targets:', iframes.map((x) => ({ id: x.targetId.slice(0, 8), url: x.url.slice(0, 60), parentId: (x.targetId && '') })));
if (!iframes.length) { console.log('no iframe found — checking panel page iframes via CDP'); process.exit(2); }

for (const f of iframes) {
  const sess = (await cdp.send('Target.attachToTarget', { targetId: f.targetId, flatten: true })).sessionId;
  await cdp.send('Runtime.enable', {}, sess);
  await sleep(500);
  // collect execution contexts via evaluate's contextId? Use Runtime.evaluate
  // on a marker then Runtime.getIsolatedContext is not a CDP method — instead
  // list contexts by triggering Runtime.enable events:
  const ctxs = [];
  const orig2 = cdp.events.length;
  for (let i = 0; i < 10 && !ctxs.length; i++) {
    // re-enable to force contextCreated events
    await cdp.send('Runtime.enable', {}, sess).catch(() => {});
    await sleep(300);
    for (let j = orig2; j < cdp.events.length; j++) {
      const e = cdp.events[j];
      if (e.method === 'Runtime.executionContextCreated' && e.sessionId === sess) {
        ctxs.push(e.params.context);
      }
    }
    if (ctxs.length) break;
  }
  console.log(`\niframe ${f.targetId.slice(0, 8)} (${f.url.slice(0, 50)}): ${ctxs.length} contexts`);
  for (const c of ctxs) {
    const tag = c.auxData && c.auxData.isolatedContext ? 'ISOLATED' : 'main    ';
    const r = await cdp.send('Runtime.evaluate',
      { expression: `({ hook: !!window.__ceComposerHook, ce: (typeof window.__ceComposerHook), doc: document.readyState, title: document.title })`,
        returnByValue: true, contextId: c.id }, sess, 10000).catch((e) => ({ err: e.message }));
    console.log(`  [${tag}] ctxId=${c.id} origin=${c.origin} →`, JSON.stringify(r.result ? r.result.value : r));
  }
}

// stage example.com tab and watch SW console for injection/panel-state activity
console.log('\nstaging example.com, watching SW console...');
const tabInfo = await evIn(swSess, `(async () => {
  const tabs = await chrome.tabs.query({ url: 'https://example.com/*' });
  return tabs.length ? tabs[0].id : null;
})()`).catch(() => null);
console.log('example.com chrome tab id:', tabInfo);
if (tabInfo) {
  await evIn(panelSess, `new Promise((res, rej) =>
    chrome.runtime.sendMessage({ type: 'chrome-eye:stage-tab', tabId: ${tabInfo} }, (r) =>
      chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r)))`);
  await sleep(4000);
  console.log('--- SW console after staging (4s) ---');
  swLogs.forEach((l) => console.log(' ', l));
  // check the button in every iframe now
  for (const f of iframes) {
    const sess = (await cdp.send('Target.attachToTarget', { targetId: f.targetId, flatten: true })).sessionId;
    const r = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => /^\\d+ staged pages?/.test(x.title || ''));
        return b ? { found: true, text: b.textContent, visible: b.style.display !== 'none' } : { found: false, buttonCount: document.querySelectorAll('button').length };
      })()`, returnByValue: true }, sess, 10000).catch(() => ({}));
    console.log(`  iframe ${f.targetId.slice(0, 8)}:`, JSON.stringify(r.result ? r.result.value : r));
  }
}

// cleanup: unstage + close panel
if (tabInfo) await evIn(panelSess, `new Promise((res) =>
  chrome.runtime.sendMessage({ type: 'chrome-eye:unstage-tab', tabId: ${tabInfo} }, () => res(1)))`).catch(() => {});
await cdp.send('Target.closeTarget', { targetId: panelTarget }).catch(() => {});
cdp.close();
console.log('\ndone');
