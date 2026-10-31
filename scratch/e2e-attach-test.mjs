#!/usr/bin/env node
// E2E test for the Task J prompt-time attach flow against a REAL external
// web tab (the user's failing scenario: a non-localhost page).
//
// Flow (all via real chrome.runtime.sendMessage from the panel page):
//   1. open https://example.com/ (real external tab)
//   2. panel → chrome-eye:stage-tab {tabId}          → {ok, staged:[1]}
//   3. panel → chrome-eye:prompt-attach              → {ok, attached:1,
//        failed:[], staged:[] (one-shot clear), contextText with markers}
//   4. panel → chrome-eye:prompt-attach AGAIN        → {ok:false,
//        error:'no staged pages'} — proves the one-shot clear
//   5. panel → chrome-eye:stage-tab again            → the composer hook in
//        the panel's GUI iframe shows its floating "\uD83D\uDDC1 1" button (poll ≤8s)
//   6. Page.captureScreenshot of the GUI iframe → evidence file
//   7. cleanup: unstage, close test tabs
//
// SAFETY: no input is ever typed into or dispatched to the real DSH composer
// in the :3081 GUI (no message is sent to the user's live session).
import fs from 'fs';
const BASE = 'http://127.0.0.1:9222';
const EXT_ID = 'mlolgaoijponghgfnlcljlohnhlpnhkd';
const EVIDENCE = '/mnt/f/ai/chrome-eye/scratch/e2e-evidence.png';

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

// ---------- 1. fresh example.com tab ----------
console.log('1. opening https://example.com/');
const pageTarget = (await cdp.send('Target.createTarget', { url: 'https://example.com/' })).targetId;
const pageSess = (await cdp.send('Target.attachToTarget', { targetId: pageTarget, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, pageSess);
let ready = false;
for (let i = 0; i < 60 && !ready; i++) {
  ready = (await evIn(pageSess, 'document.readyState').catch(() => '')) === 'complete';
  if (!ready) await sleep(500);
}
check('example.com loaded', ready);

// ---------- 2. panel page (wakes SW, natural hook injection path) ----------
console.log('2. opening panel page');
const panelTarget = (await cdp.send('Target.createTarget', { url: 'chrome-extension://' + EXT_ID + '/panel.html' })).targetId;
const panelSess = (await cdp.send('Target.attachToTarget', { targetId: panelTarget, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, panelSess);
for (let i = 0; i < 40 && (await evIn(panelSess, 'document.readyState').catch(() => '')) !== 'complete'; i++) await sleep(500);

// ---------- 3. wake + attach SW ----------
let swTarget = null;
for (let i = 0; i < 24 && !swTarget; i++) {
  swTarget = (await listTargets()).find((x) => x.type === 'service_worker' && x.url && x.url.indexOf(EXT_ID) !== -1) || null;
  if (!swTarget) {
    await evIn(panelSess, `chrome.runtime.sendMessage({ type: 'chrome-eye:panel-state' }).then(() => 1).catch(() => 0)`, 5000).catch(() => {});
    await sleep(500);
  }
}
check('SW target found', !!swTarget);
const swSess = (await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, swSess);
const swEval = (expr) => evIn(swSess, expr);

// chrome tab id of example.com (chrome.tabs API id, not CDP target id)
const tabInfo = await swEval(`(async () => {
  const tabs = await chrome.tabs.query({ url: 'https://example.com/*' });
  return tabs.length ? { id: tabs[0].id, url: tabs[0].url, title: tabs[0].title } : null;
})()`);
check('example.com chrome tab found', !!tabInfo, tabInfo && { id: tabInfo.id, title: tabInfo.title });
const CHROME_TAB_ID = tabInfo && tabInfo.id;

// ---------- 4. stage the external tab ----------
console.log('3. staging the external tab');
const staged = await evIn(panelSess, `new Promise((res, rej) =>
  chrome.runtime.sendMessage({ type: 'chrome-eye:stage-tab', tabId: ${CHROME_TAB_ID} }, (r) =>
    chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r)))`);
check('stage-tab ok', staged && staged.ok === true, staged);
check('staged list has 1 entry', staged && Array.isArray(staged.staged) && staged.staged.length === 1);

// ---------- 5. prompt-attach: fresh capture + context block ----------
console.log('4. prompt-attach (fresh capture of the external tab)');
const attach = await evIn(panelSess, `new Promise((res, rej) =>
  chrome.runtime.sendMessage({ type: 'chrome-eye:prompt-attach' }, (r) =>
    chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r)))`, 60000);
check('attach ok', attach && attach.ok === true, attach && { attached: attach.attached, failed: attach.failed && attach.failed.length });
check('attached:1 failed:0', attach && attach.attached === 1 && attach.failed.length === 0);
check('one-shot clear (staged now empty)', attach && Array.isArray(attach.staged) && attach.staged.length === 0);
const ct = attach && attach.contextText || '';
check('contextText header', ct.indexOf('[chrome-eye: context from 1 staged page, captured just now]') === 0);
check('contextText has url marker', ct.indexOf('https://example.com/') !== -1);
check('contextText has page title', ct.indexOf('Example Domain') !== -1);
check('contextText has section banner', /=== 1\. Example Domain — https:\/\/example\.com\/ ===/.test(ct));
console.log('  contextText (first 300 chars):\n    ' + ct.slice(0, 300).replace(/\n/g, '\n    '));

// ---------- 6. second prompt-attach must refuse (one-shot) ----------
console.log('5. second prompt-attach (one-shot check)');
const attach2 = await evIn(panelSess, `new Promise((res, rej) =>
  chrome.runtime.sendMessage({ type: 'chrome-eye:prompt-attach' }, (r) =>
    chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r)))`);
check('second attach refused', attach2 && attach2.ok === false && attach2.error === 'no staged pages', attach2);

// ---------- 7. re-stage → hook button appears in GUI iframe ----------
console.log('6. re-stage; waiting for composer hook "\u{1F5C1}" button in GUI iframe');
await evIn(panelSess, `new Promise((res, rej) =>
  chrome.runtime.sendMessage({ type: 'chrome-eye:stage-tab', tabId: ${CHROME_TAB_ID} }, (r) =>
    chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(r)))`);

// find the panel's GUI iframe target — MUST be the iframe whose parentId is
// OUR panel target: stale panels from earlier runs leave other :3081
// iframes around and first-match would read a frozen/stale document.
let guiFrame = null;
for (let i = 0; i < 20 && !guiFrame; i++) {
  guiFrame = (await listTargets()).find((x) =>
    x.type === 'iframe' && x.url && x.url.indexOf('127.0.0.1:3081') !== -1 &&
    x.parentId === panelTarget) || null;
  if (!guiFrame) await sleep(500);
}
check('GUI iframe target found', !!guiFrame, guiFrame && guiFrame.url.slice(0, 50));
let hookSeen = false, hookDetail = null;
let iframeSess = null;
if (guiFrame) {
  iframeSess = (await cdp.send('Target.attachToTarget', { targetId: guiFrame.targetId, flatten: true })).sessionId;
  await cdp.send('Runtime.enable', {}, iframeSess);
  for (let i = 0; i < 16 && !hookSeen; i++) {
    await sleep(500);
    hookDetail = await evIn(iframeSess, `(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const b = btns.find((x) => /^\\d+ staged pages? — attached to your next prompt/.test(x.title || ''));
      if (!b) return { found: false, buttonCount: btns.length, readyState: document.readyState };
      return { found: true, text: b.textContent, title: b.title, visible: b.style.display !== 'none' };
    })()`, 5000).catch(() => null);
    hookSeen = !!(hookDetail && hookDetail.found);
  }
}
check('hook button present', hookSeen, hookDetail);
check('hook button visible', !!(hookDetail && hookDetail.visible && /\uD83D\uDDC1 1/.test(hookDetail.text || '')), hookDetail);

// ---------- 8. screenshot evidence (top-level panel capture composites the GUI iframe) ----------
// NOTE: Page.captureScreenshot only works on TOP-LEVEL targets. The :3081 GUI iframe is
// an OOPIF (non-top-level), so capture the panel page itself — the compositor includes
// the cross-origin iframe content in the capture.
{
  await cdp.send('Page.enable', {}, panelSess).catch((e) => console.log('  Page.enable err:', e.message));
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, panelSess).catch((e) => { console.log('  captureScreenshot err:', e.message); return null; });
  if (shot && shot.data) {
    fs.writeFileSync(EVIDENCE, Buffer.from(shot.data, 'base64'));
    check('screenshot saved', true, EVIDENCE + ' (' + fs.statSync(EVIDENCE).size + ' bytes)');
  } else {
    check('screenshot saved', false, 'captureScreenshot failed');
  }
}

// ---------- 8b. popover lifecycle in the real GUI iframe ----------
// Opens on badge click; closes on in-document outside mousedown and on window
// blur (a click outside the iframe never reaches its document); re-opens
// visible (display reset regression).
console.log('6b. popover lifecycle in the GUI iframe');
{
  // Property-based query: reading style.cssText re-serializes with spaces
  // ("width: 340px"), so a substring search for "width:340px" never matches.
  const popQuery = `Array.from(document.querySelectorAll('div')).find((d) => d.style.width === '340px' && d.style.zIndex === '2147483001')`;
  const badgeQuery = `Array.from(document.querySelectorAll('button')).find((x) => /^\\d+ staged pages? — attached to your next prompt/.test(x.title || ''))`;
  if (!iframeSess) {
    check('popover lifecycle (skipped: no iframe session)', false, 'iframeSess unavailable');
  } else {
    const openRes = await evIn(iframeSess, `new Promise((res) => {
      const b = ${badgeQuery};
      if (!b) { res({ error: 'badge not found' }); return; }
      b.click();
      setTimeout(() => { const p = ${popQuery}; res(p ? { found: true, display: p.style.display } : { found: false }); }, 300);
    })`, 6000).catch((e) => ({ error: e.message }));
    check('popover opens on badge click', !!(openRes && openRes.found && openRes.display === ''), openRes);

    const closeRes = await evIn(iframeSess, `new Promise((res) => {
      const p = ${popQuery};
      if (!p) { res({ error: 'popover missing' }); return; }
      const box = document.querySelector('[data-composer-input="true"][contenteditable="true"]') || document.body;
      box.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      setTimeout(() => res({ display: p.style.display }), 200);
    })`, 6000).catch((e) => ({ error: e.message }));
    check('popover closes on in-doc outside mousedown', closeRes && closeRes.display === 'none', closeRes);

    const reopenRes = await evIn(iframeSess, `new Promise((res) => {
      const b = ${badgeQuery};
      if (!b) { res({ error: 'badge not found' }); return; }
      b.click();
      setTimeout(() => { const p = ${popQuery}; res(p ? { found: true, display: p.style.display } : { found: false }); }, 200);
    })`, 6000).catch((e) => ({ error: e.message }));
    check('popover re-opens visible (display reset)', !!(reopenRes && reopenRes.found && reopenRes.display === ''), reopenRes);

    const blurRes = await evIn(iframeSess, `new Promise((res) => {
      const p = ${popQuery};
      if (!p) { res({ error: 'popover missing' }); return; }
      window.dispatchEvent(new Event('blur'));
      setTimeout(() => res({ display: p.style.display }), 200);
    })`, 6000).catch((e) => ({ error: e.message }));
    check('popover closes on window blur (outside-iframe click)', blurRes && blurRes.display === 'none', blurRes);
  }
}

// ---------- 9. cleanup ----------
console.log('7. cleanup');
await evIn(panelSess, `new Promise((res) =>
  chrome.runtime.sendMessage({ type: 'chrome-eye:unstage-tab', tabId: ${CHROME_TAB_ID} }, () => res(1)))`).catch(() => {});
await cdp.send('Target.closeTarget', { targetId: pageTarget }).catch(() => {});
await cdp.send('Target.closeTarget', { targetId: panelTarget }).catch(() => {});
const finalStaged = await swEval(`JSON.stringify(stagedTabs)`).catch(() => 'n/a');
check('staged cleared after cleanup', finalStaged === '[]', finalStaged);

cdp.close();
console.log(failures === 0 ? '\nE2E: ALL CHECKS PASSED' : `\nE2E: ${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
