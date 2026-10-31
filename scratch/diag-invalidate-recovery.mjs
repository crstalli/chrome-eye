// Chrome Eye — invalidation-recovery probe (panel half of the Task J fix).
//
// Simulates the POST-reload state WITHOUT reloading the extension:
//   1. stage a tab -> hook badge appears in the :3081 iframe
//   2. from the panel's MAIN world, dispatch the exact message the hook
//      posts when its chrome.runtime dies:
//        {source:'chrome-eye-hook', type:'chrome-eye:context-invalidated'}
//   3. panel.js must reset dshIframe.src -> the old iframe target dies,
//      a fresh :3081 iframe (same parentId) loads
//   4. the manifest re-injects the hook on the fresh doc -> the badge
//      must re-arm (SW staged state is untouched by the reload)
//   5. a second identical post within 10 s must NOT reload again
//      (panel.js loop guard)
//
// Run:  node scratch/diag-invalidate-recovery.mjs   (headless :9222 up)
import { strict as assert } from 'node:assert';

const CDP = 'http://127.0.0.1:9222';
const EXT = 'mlolgaoijponghgfnlcljlohnhlpnhkd';

const ver = await (await fetch(CDP + '/json/version')).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let seq = 0; const pend = new Map();
const send = (m, p = {}, s) => {
  const id = ++seq;
  const msg = { id, method: m, params: p };
  if (s) msg.sessionId = s;
  ws.send(JSON.stringify(msg));
  return new Promise((res, rej) => pend.set(id, { res, rej }));
};
ws.onmessage = (e) => {
  const d = JSON.parse(e.data);
  if (d.id && pend.has(d.id)) {
    const p = pend.get(d.id); pend.delete(d.id);
    d.error ? p.rej(new Error(d.error.message)) : p.res(d.result);
  }
};
const evIn = (s, expr, ms = 10000) => send('Runtime.evaluate',
  { expression: expr, returnByValue: true, awaitPromise: true, timeout: ms }, s
).then((r) => { if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = () => send('Target.getTargets').then((r) => r.targetInfos);

const badgeQuery = `(function(){
  const btns = Array.from(document.querySelectorAll('button'));
  const b = btns.find((x) => x.title && x.title.indexOf('staged page') !== -1);
  if (!b) return {found:false};
  const r = b.getBoundingClientRect();
  return {found:true, text:b.textContent, title:b.title, visible:r.width>0&&r.height>0};
})()`;

const guiIframe = async (panelTarget) => (await targets())
  .find((x) => x.type === 'iframe' && x.url.indexOf('127.0.0.1:3081') !== -1 && x.parentId === panelTarget);

// ---- setup: example tab + panel + SW nudge ----------------------------
const pageTarget = (await send('Target.createTarget', { url: 'https://example.com/' })).targetId;
const panelTarget = (await send('Target.createTarget', { url: 'chrome-extension://' + EXT + '/panel.html' })).targetId;
const panelSess = (await send('Target.attachToTarget', { targetId: panelTarget, flatten: true })).sessionId;
await send('Runtime.enable', {}, panelSess);
for (let i = 0; i < 30; i++) {
  const rs = await evIn(panelSess, 'document.readyState').catch(() => '');
  if (rs === 'complete') break;
  await sleep(500);
}
let state = null;
for (let i = 0; i < 30; i++) {
  state = await evIn(panelSess, 'new Promise((res) => chrome.runtime.sendMessage({type:"chrome-eye:panel-state"}, (r) => res(r)))').catch(() => null);
  if (state && state.ok !== undefined) break;
  await sleep(500);
}
assert.ok(state && state.ok, 'panel-state ok');
// unstage leftovers for a clean count
for (const st of state.staged || []) {
  await evIn(panelSess, `new Promise((res) => chrome.runtime.sendMessage({type:"chrome-eye:unstage-tab", tabId:${st.id}}, (r) => res(r)))`).catch(() => {});
}
// chrome tab id via the SW's chrome.tabs API (CDP target id != chrome tab id)
const swT = (await targets()).find((x) => x.type === 'service_worker' && x.url.indexOf(EXT) !== -1);
assert.ok(swT, 'SW target alive after nudge');
const swSess = (await send('Target.attachToTarget', { targetId: swT.targetId, flatten: true })).sessionId;
await send('Runtime.enable', {}, swSess);
const tabInfo = await evIn(swSess, `(async () => {
  const tabs = await chrome.tabs.query({ url: 'https://example.com/*' });
  return tabs.length ? { id: tabs[0].id, url: tabs[0].url } : null;
})()`).catch(() => null);
assert.ok(tabInfo && tabInfo.id, 'example.com chrome tab found: ' + JSON.stringify(tabInfo));
let staged = null;
for (let attempt = 1; attempt <= 3; attempt++) {
  staged = await evIn(panelSess, `new Promise((res) => chrome.runtime.sendMessage({type:"chrome-eye:stage-tab", tabId:${tabInfo.id}}, (r) => res(r)))`).catch(() => null);
  if (staged && staged.ok) break;
  await sleep(1000);
}
assert.ok(staged && staged.ok && staged.staged.length === 1, 'staged one tab: ' + JSON.stringify(staged));

// wait for the badge in the fresh iframe
let gui = null;
for (let i = 0; i < 40 && !gui; i++) { gui = await guiIframe(panelTarget); await sleep(500); }
assert.ok(gui, 'gui iframe found');
let guiSess = (await send('Target.attachToTarget', { targetId: gui.targetId, flatten: true })).sessionId;
await send('Runtime.enable', {}, guiSess);
let badge = null;
for (let i = 0; i < 40; i++) {
  badge = await evIn(guiSess, badgeQuery).catch(() => null);
  if (badge && badge.found) break;
  await sleep(500);
}
assert.ok(badge && badge.found, 'badge armed before invalidation: ' + JSON.stringify(badge));
const oldGuiId = gui.targetId;
console.log('[1] badge armed in iframe', oldGuiId, '->', JSON.stringify(badge.text));

// ---- 2. panel.js must reload the iframe document ----------------------
// Marker FIRST (the reload kills the old OOPIF target within ~100 ms),
// then the invalidation post. Detection: marker gone + new iframe target.
await evIn(guiSess, `window.__ceProbeMarker = 'old-${Date.now()}'`);
const markerBefore = await evIn(guiSess, 'window.__ceProbeMarker');
await evIn(panelSess, `window.postMessage({source:'chrome-eye-hook', type:'chrome-eye:context-invalidated'}, '*'); 'posted'`);
console.log('[2] invalidation message posted from panel main world');
let reloaded = false;
for (let i = 0; i < 40; i++) {
  const m = await evIn(guiSess, 'window.__ceProbeMarker || null').catch(() => null);
  if (m === null || m !== markerBefore) { reloaded = true; break; }
  await sleep(250);
}
assert.ok(reloaded, 'iframe document reloaded after invalidation post (marker gone)');
console.log('[3] panel.js reloaded the iframe document (marker', markerBefore, '-> gone)');

// ---- 3. the :3081 doc reloaded IN PLACE: the frame keeps the same CDP
// target id across the about:blank round-trip, but the old CDP session
// died with the old document — attach a fresh one --------------------
let freshGui = null;
for (let i = 0; i < 40 && !freshGui; i++) {
  freshGui = await guiIframe(panelTarget);
  if (!freshGui) await sleep(250);
}
assert.ok(freshGui, 'gui iframe target back on :3081: ' + JSON.stringify(freshGui && freshGui.targetId));
guiSess = (await send('Target.attachToTarget', { targetId: freshGui.targetId, flatten: true })).sessionId;
await send('Runtime.enable', {}, guiSess);
console.log('[4] re-attached to iframe target', freshGui.targetId,
  freshGui.targetId === oldGuiId ? '(same id, fresh document)' : '(new id)');

// ---- 4. loop guard: second post within 10 s must NOT reload -----------
// (done right away so it is definitely inside the 10 s cooldown)
await evIn(guiSess, `window.__ceProbeMarker2 = 'still-${Date.now()}'`);
await evIn(panelSess, `window.postMessage({source:'chrome-eye-hook', type:'chrome-eye:context-invalidated'}, '*'); 'posted2'`);
await sleep(4000);
const marker2 = await evIn(guiSess, 'window.__ceProbeMarker2 || null').catch(() => null);
assert.ok(marker2 && marker2.indexOf('still-') === 0, 'loop guard: no second reload within 10 s');
console.log('[5] loop guard held: marker', marker2, 'survived 2nd post');

// ---- 5. hook re-injected on fresh doc: badge re-arms ------------------
badge = null;
for (let i = 0; i < 40; i++) {
  badge = await evIn(guiSess, badgeQuery).catch(() => null);
  if (badge && badge.found) break;
  await sleep(500);
}
assert.ok(badge && badge.found, 'badge re-armed after iframe reload: ' + JSON.stringify(badge));
console.log('[6] badge re-armed on fresh iframe ->', JSON.stringify(badge.text));

// ---- cleanup -----------------------------------------------------------
await evIn(panelSess, `new Promise((res) => chrome.runtime.sendMessage({type:"chrome-eye:unstage-tab", tabId:${staged.staged[0].id}}, (r) => res(r)))`).catch(() => {});
const after = await evIn(panelSess, 'new Promise((res) => chrome.runtime.sendMessage({type:"chrome-eye:panel-state"}, (r) => res(r)))').catch(() => null);
console.log('[7] cleanup: staged after unstage =', JSON.stringify(after && after.staged));
await send('Target.closeTarget', { targetId: pageTarget }).catch(() => {});
await send('Target.closeTarget', { targetId: panelTarget }).catch(() => {});
ws.close();
console.log('INVALIDATION-RECOVERY PROBE: ALL CHECKS PASSED');
