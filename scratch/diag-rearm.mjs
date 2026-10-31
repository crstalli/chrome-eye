// Repro of E2E #2's exact armed 0→1→0→1 sequence with full visibility:
//   A) stage from panel  → badge should become VISIBLE
//   B) prompt-attach     → SW one-shot clears → badge should hide
//   C) re-stage          → badge should become VISIBLE again  (the failing step)
// Captures: SW targetId/timeOrigin, stagedTabs.length, badge {text,display,
// left,top}, send-button rect, and the hook's console logs (isolated world,
// visible via Runtime.consoleAPICalled on the iframe session).
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ver = await (await fetch(BASE + '/json/version')).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
const cdp = {
  onEvent: null,
  send(method, params = {}, sessionId) {
    const id = ++seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  },
  close() { ws.close(); },
};
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) {
    const p = pending.get(d.id);
    pending.delete(d.id);
    d.error ? p.rej(new Error(d.error.message)) : p.res(d.result);
  } else if (d.method && cdp.onEvent) cdp.onEvent(d);
};
const listTargets = async () => (await cdp.send('Target.getTargets')).targetInfos;
const evIn = async (sess, expr, timeout = 8000) => {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true, timeout,
  }, sess);
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};

// ---- fresh example.com tab
const pageTarget = (await cdp.send('Target.createTarget', { url: 'https://example.com/' })).targetId;
await sleep(5000);

// ---- open the side panel (direct target, as in diag-final)
let EXT_ID = (await listTargets()).find((t) => t.url && t.url.startsWith('chrome-extension://'))
  ?.url.split('//')[1].split('/')[0] || 'mlolgaoijponghgfnlcljlohnhlpnhkd';
const panelId = (await cdp.send('Target.createTarget', { url: 'chrome-extension://' + EXT_ID + '/panel.html' })).targetId;
const panelTarget = { targetId: panelId };
const panelSess = (await cdp.send('Target.attachToTarget', { targetId: panelId, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, panelSess);
for (let i = 0; i < 40 && (await evIn(panelSess, 'document.readyState').catch(() => '')) !== 'complete'; i++) await sleep(500);
await sleep(1500);

// ---- GUI iframe (:3081) — the hook lives here
let gui = null;
for (let i = 0; i < 20 && !gui; i++) {
  gui = (await listTargets()).find((x) => x.type === 'iframe' && x.url && x.url.indexOf('127.0.0.1:3081') !== -1) || null;
  if (!gui) await sleep(500);
}
assert.ok(gui, 'GUI iframe not found');
const iframeSess = (await cdp.send('Target.attachToTarget', { targetId: gui.targetId, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, iframeSess);
let T0 = Date.now();
const hookLogs = [];
cdp.onEvent = (d) => {
  if (d.method === 'Runtime.consoleAPICalled' && d.sessionId === iframeSess) {
    const txt = (d.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    hookLogs.push(((Date.now() - T0) / 1000).toFixed(1) + 's ' + txt);
  }
};
// wait for the hook to boot in the iframe
for (let i = 0; i < 40; i++) {
  await sleep(500);
  if (hookLogs.some((l) => l.includes('composer-hook active'))) break;
}
console.log('hook boot log:', hookLogs.filter((l) => l.includes('composer-hook')).join(' | ') || 'NONE');

// ---- SW
let sw = null;
for (let i = 0; i < 40 && !sw; i++) {
  sw = (await listTargets()).find((t) => t.type === 'service_worker' && t.url && t.url.indexOf('sw.js') !== -1) || null;
  if (!sw) await sleep(500);
}
const swSess = (await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, swSess);
const swLogs = [];
const prevOnEvent = cdp.onEvent;
cdp.onEvent = (d) => {
  if (d.method === 'Runtime.consoleAPICalled' && d.sessionId === swSess) {
    const txt = (d.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    swLogs.push(((Date.now() - T0) / 1000).toFixed(1) + 's ' + txt);
  }
  if (prevOnEvent) prevOnEvent(d);
};
const swEval = (e) => evIn(swSess, e);
const swId = () => swEval('JSON.stringify({ to: performance.timeOrigin, n: (typeof stagedTabs !== "undefined") ? stagedTabs.length : -1 })').catch((e) => 'ERR ' + e.message);

const state = async (label) => {
  const badge = await evIn(iframeSess, `(() => {
    const b = Array.from(document.querySelectorAll('button'))
      .find((x) => /^\\d+ staged pages? — attached to your next prompt/.test(x.title || ''));
    const send = document.querySelector('button[aria-label="Send message"]');
    const sr = send ? send.getBoundingClientRect() : null;
    return JSON.stringify({
      badge: b ? { text: b.textContent, display: b.style.display, left: b.style.left, top: b.style.top } : null,
      send: sr ? { w: sr.width, h: sr.height, x: sr.x, y: sr.y } : null,
      ready: document.readyState,
    });
  })()`).catch((e) => 'ERR ' + e.message);
  const sid = await swId();
  console.log(label, 'badge=' + badge, 'sw=' + sid);
  return { badge, sid };
};

let LAST_TAB_ID = null;
const stage = async (label) => {
  let r = null;
  for (let attempt = 1; attempt <= 3 && (!r || !r.ok); attempt++) {
    const tab = await evIn(panelSess, `new Promise((res) => {
      chrome.tabs.query({ url: 'https://example.com/*' }, (ts) =>
        res(ts.length ? { id: ts[0].id } : null));
    })`);
    if (!tab || tab.id == null) { console.log(label, 'stage: NO example tab found'); return r; }
    LAST_TAB_ID = tab.id;
    const expr = `new Promise((res, rej) =>
      chrome.runtime.sendMessage({ type: 'chrome-eye:stage-tab', tabId: ${tab.id} }, (x) =>
        chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(x)))`;
    r = await evIn(panelSess, expr);
    console.log(label, 'stage attempt', attempt, 'tabId:', tab.id, 'response:', JSON.stringify(r));
    if (r && r.ok) break;
    await sleep(1500);
  }
  return r;
};

const waitBadge = async (label, wantVisible, maxS = 10) => {
  const t0 = Date.now();
  let last = null;
  while ((Date.now() - t0) / 1000 < maxS) {
    await sleep(750);
    last = await state(label + ' t+' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
    const b = JSON.parse(last.badge === 'ERR' || last.badge.startsWith('ERR') ? 'null' : last.badge).badge;
    const visible = !!(b && b.display !== 'none' && b.text);
    if (visible === wantVisible) break;
  }
  return last;
};

// ---- reset: clear leftover staging from previous diag runs
{
  const t = await evIn(panelSess, `new Promise((res) => {
    chrome.tabs.query({ url: 'https://example.com/*' }, (ts) =>
      res(ts.length ? { id: ts[0].id } : null));
  })`);
  if (t && t.id) {
    await evIn(panelSess, `new Promise((res) =>
      chrome.runtime.sendMessage({ type: 'chrome-eye:unstage-tab', tabId: ${t.id} }, () => res(1)))`).catch(() => {});
    console.log('reset: unstaged leftover tab', t.id);
  }
}
// wait for the :3081 SPA to render its composer + send button
for (let i = 0; i < 30; i++) {
  const has = await evIn(iframeSess, `!!document.querySelector('button[aria-label="Send message"]')`).catch(() => false);
  if (has) break;
  await sleep(500);
}
console.log('--- baseline (nothing staged)');
await state('base');

console.log('--- A) stage → badge should become VISIBLE');
await stage('A');
await waitBadge('A', true);

console.log('--- B) prompt-attach → SW clears → badge should HIDE');
const attach = await evIn(panelSess, `new Promise((res, rej) =>
  chrome.runtime.sendMessage({ type: 'chrome-eye:prompt-attach' }, (x) =>
    chrome.runtime.lastError ? rej(new Error(chrome.runtime.lastError.message)) : res(x)))`, 60000).catch((e) => ({ error: e.message }));
console.log('B attach ok:', attach && attach.ok, 'attached:', attach && attach.attached);
await waitBadge('B', false, 8);

console.log('--- C) re-stage → badge should become VISIBLE again');
await stage('C');
await waitBadge('C', true, 12);

console.log('--- hook console log:');
for (const l of hookLogs) console.log('   ', l);
console.log('--- SW console log:');
for (const l of swLogs) console.log('   ', l);

// cleanup
if (LAST_TAB_ID) {
  await evIn(panelSess, `new Promise((res) =>
    chrome.runtime.sendMessage({ type: 'chrome-eye:unstage-tab', tabId: ${LAST_TAB_ID} }, () => res(1)))`).catch(() => {});
}
await cdp.send('Target.closeTarget', { targetId: panelTarget.targetId }).catch(() => {});
await cdp.send('Target.closeTarget', { targetId: pageTarget }).catch(() => {});
cdp.close();
