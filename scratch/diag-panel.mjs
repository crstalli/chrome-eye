#!/usr/bin/env node
// scratch/diag-panel.mjs — open the panel page in headless Chrome, stage one
// tab, then dump EVERY hook badge button in the :3081 GUI iframe (count,
// display, text) plus the send-button state, to diagnose double-injection /
// hidden-badge issues after the declared-content-script change.
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
async function evIn(cdp, sessionId, expr, timeoutMs = 10000) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId, timeoutMs);
  if (r.exceptionDetails) throw new Error('exception: ' + JSON.stringify(r.exceptionDetails).slice(0, 500));
  return r.result.value;
}

const ver = await (await fetch(BASE + '/json/version')).json();
const cdp = await Cdp.connect(ver.webSocketDebuggerUrl);
const listTargets = () => cdp.send('Target.getTargets').then((r) => r.targetInfos);

// 1. example.com tab (staging candidate)
const pageTarget = await cdp.send('Target.createTarget', { url: 'https://example.com/' });
await sleep(2500);

// 2. panel page
const panelTarget = await cdp.send('Target.createTarget', { url: 'chrome-extension://' + EXT_ID + '/panel.html' });
await sleep(5000);

// 3. SW: find the chrome tab id and stage it
const swTarget = (await listTargets()).find((t) => t.type === 'service_worker' && t.url.includes(EXT_ID));
if (!swTarget) { console.log('FATAL: no SW'); process.exit(1); }
const swSess = (await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, swSess);
const CHROME_TAB = await evIn(cdp, swSess, `new Promise((res) => chrome.tabs.query({ url: 'https://example.com/*' }, (ts) => res(ts[0] ? ts[0].id : null)))`);
console.log('chrome tab to stage:', CHROME_TAB);
await evIn(cdp, swSess, `new Promise((res) => chrome.runtime.sendMessage({ type: 'chrome-eye:stage-tab', tabId: ${CHROME_TAB} }, (r) => res(r)))`);

// 4. GUI iframe target
let gui = null;
for (let i = 0; i < 30 && !gui; i++) {
  gui = (await listTargets()).find((t) => t.type === 'iframe' && t.url && t.url.indexOf('127.0.0.1:3081') !== -1) || null;
  if (!gui) await sleep(500);
}
if (!gui) { console.log('FATAL: no GUI iframe'); process.exit(1); }
console.log('gui iframe:', gui.url);
const guiSess = (await cdp.send('Target.attachToTarget', { targetId: gui.targetId, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, guiSess);

const dumpExpr = `(() => {
  const badges = Array.from(document.querySelectorAll('button')).filter((b) => /staged pages? — attached/.test(b.title || ''));
  const sendBtns = Array.from(document.querySelectorAll('button[aria-label="Send message"]'));
  return {
    readyState: document.readyState,
    badgeCount: badges.length,
    badges: badges.map((b) => ({ text: b.textContent, display: b.style.display, left: b.style.left, top: b.style.top })),
    sendBtnCount: sendBtns.length,
    sendBtns: sendBtns.map((b) => { const r = b.getBoundingClientRect(); return { display: b.style.display, rect: [r.x, r.y, r.width, r.height] }; }),
    composerBoxes: document.querySelectorAll('[data-composer-input="true"][contenteditable="true"]').length,
  };
})()`;

for (const t of [3, 6, 10]) {
  await sleep(t * 1000);
  const swNow = (await listTargets()).find((x) => x.type === 'service_worker' && x.url.includes(EXT_ID));
  const swStaged = await evIn(cdp, swSess, `JSON.stringify(stagedTabs)`).catch((e) => 'ERR:' + e.message.slice(0, 80));
  const dump = await evIn(cdp, guiSess, dumpExpr);
  console.log('t+' + t + 's: swTargetId=' + (swNow && swNow.targetId) + ' swStaged=' + swStaged + ' ' + JSON.stringify(dump));
}

// 5. click the first VISIBLE badge → popover state
const clickRes = await evIn(cdp, guiSess, `new Promise((res) => {
  const badges = Array.from(document.querySelectorAll('button')).filter((b) => /staged pages? — attached/.test(b.title || ''));
  const vis = badges.find((b) => b.style.display !== 'none');
  if (!vis) { res({ clicked: false, badgeCount: badges.length }); return; }
  vis.click();
  setTimeout(() => {
    const pops = Array.from(document.querySelectorAll('div')).filter((d) => d.style.cssText.indexOf('width:340px') !== -1 && d.style.cssText.indexOf('2147483001') !== -1);
    res({ clicked: true, popoverCount: pops.length, pops: pops.map((p) => ({ display: p.style.display })) });
  }, 400);
})`);
console.log('click result:', JSON.stringify(clickRes));

// 6. simulate an outside-iframe click (window blur) and re-check
const blurRes = await evIn(cdp, guiSess, `new Promise((res) => {
  const pops = Array.from(document.querySelectorAll('div')).filter((d) => d.style.cssText.indexOf('width:340px') !== -1 && d.style.cssText.indexOf('2147483001') !== -1);
  window.dispatchEvent(new Event('blur'));
  setTimeout(() => res({ popoverCount: pops.length, pops: pops.map((p) => ({ display: p.style.display })) }), 300);
})`);
console.log('after blur:', JSON.stringify(blurRes));

// cleanup
await evIn(cdp, swSess, `new Promise((res) => chrome.runtime.sendMessage({ type: 'chrome-eye:unstage-tab', tabId: ${CHROME_TAB} }, () => res(1)))`).catch(() => {});
await cdp.send('Target.closeTarget', { targetId: pageTarget.targetId }).catch(() => {});
await cdp.send('Target.closeTarget', { targetId: panelTarget.targetId }).catch(() => {});
cdp.close();
process.exit(0);
