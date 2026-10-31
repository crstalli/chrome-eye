// Real-tab regression test, SAME profile as test-panel-only.mjs (cookie persists).
// Proves: (a) real :3080 tab is PREFERRED by the SW (plain top-frame send, no frameId),
// (b) overlay routes to the REAL tab DOM, absent from the panel iframe,
// (c) share chip flow still works. Writes scratch/results-real-tab.json.

import { readFileSync, writeFileSync } from 'node:fs';
import {
  sleep, waitForTarget, attach, makeConsoleSink,
  SHARE_STATUS_EXPR, waitTreeSettled,
} from './lib-cdp.mjs';

const extId = readFileSync(new URL('./ext-id.txt', import.meta.url), 'utf8').trim();
const GUI_PREFIX = 'http://127.0.0.1:3080/';
const PANEL_URL = 'chrome-extension://' + extId + '/panel.html';

const results = { mode: 'real-tab regression (cookie)', steps: [] };
function rec(step, data) {
  results.steps.push({ step, data });
  const s = JSON.stringify(data, null, 1);
  console.log('== ' + step + ' ==\n' + (s.length > 3000 ? s.slice(0, 3000) + '\n…(truncated in log; full in results file)' : s));
}
function finish(code) {
  writeFileSync(new URL('./results-real-tab.json', import.meta.url), JSON.stringify(results, null, 1));
  console.log('\nRESULTS WRITTEN -> scratch/results-real-tab.json (' + results.steps.length + ' steps)');
  process.exit(code);
}

try {
  // ---- 1) locate panel tab + panel iframe; attach panel; wake + attach SW ----
  const panel = await waitForTarget((t) => t.type === 'page' && t.url.indexOf('panel.html') !== -1, 15000, 'panel tab');
  const cPanel = await attach(panel, 'panel');
  await cPanel.send('Runtime.enable');
  let ready = false;
  for (let i = 0; i < 40; i++) {
    ready = await cPanel.evaluate(`!!document.getElementById('ws-tree-btn')`);
    if (ready) break;
    await sleep(250);
  }
  rec('panel-ready', { ready });

  await cPanel.evaluate(`Promise.resolve(chrome.runtime.sendMessage({type:'__probe-wake__'})).catch(function(){}); 'sent'`);
  const sw = await waitForTarget((t) => t.type === 'service_worker' && t.url.indexOf('chrome-extension://' + extId) !== -1, 15000, 'service worker (extension)');
  const cSw = await attach(sw, 'sw');
  await cSw.send('Runtime.enable');
  await cSw.send('Network.enable');
  const sinkSw = makeConsoleSink();
  sinkSw.hook(cSw);

  // ---- 2) monkey-patch the SW to record every chrome.tabs.sendMessage ---------
  const patchRes = await cSw.evaluate(`(function(){
    if (self.__cePatched) return 'already-patched';
    var o = chrome.tabs.sendMessage;
    chrome.tabs.sendMessage = function (a, b, c) {
      try { self.__lastGuiSend = { tabId: a, type: b && b.type, frameId: c && c.frameId }; } catch (e) {}
      return o.apply(chrome.tabs, arguments);
    };
    self.__cePatched = true;
    return 'patched';
  })()`);
  rec('sw-patch', { result: patchRes });

  // ---- 3) attach the panel's :3080 iframe (for the negative routing check) -----
  let frame = null;
  for (let i = 0; i < 10 && !frame; i++) {
    const ts = await import('./lib-cdp.mjs').then((m) => m.listTargets());
    frame = ts.find((t) => t.type === 'iframe' && t.url.indexOf(GUI_PREFIX) === 0) || null;
    if (!frame) await sleep(500);
  }
  if (!frame) throw new Error('panel :3080 iframe target not found');
  const cFrame = await attach(frame, 'panel-iframe');
  await cFrame.send('Runtime.enable');
  const sinkFrame = makeConsoleSink();
  sinkFrame.hook(cFrame);
  rec('panel-iframe-attached', { id: frame.id });

  // ---- 4) open the REAL :3080 tab ----------------------------------------------
  await cPanel.send('Target.createTarget', { url: GUI_PREFIX });
  const realTab = await waitForTarget((t) => t.type === 'page' && t.url.indexOf(GUI_PREFIX) === 0, 15000, 'real GUI tab');
  const cReal = await attach(realTab, 'real-tab');
  await cReal.send('Runtime.enable');
  const sinkReal = makeConsoleSink();
  sinkReal.hook(cReal);

  let gui = null;
  for (let i = 0; i < 60; i++) {
    gui = JSON.parse(await cReal.evaluate(`JSON.stringify({
      rs: document.readyState,
      centerCol: !!document.querySelector('[class*="_centerCol"]'),
      sidebar: !!document.querySelector('[class*="_groupSection"], [class*="_sessionRow"]'),
      is401: (document.body ? document.body.innerText : '').indexOf('authentication required') !== -1
    })`));
    if (gui.centerCol || gui.sidebar) break;
    await sleep(500);
  }
  await sleep(1500);
  rec('real-tab-loaded', gui);
  await sleep(1200); // let the manifest content script (document_idle) finish
  rec('real-tab-load-markers', { count: sinkReal.markers().length, note: '1 => manifest-injected at load; 0 => injection happened before attach (acceptable, noted)' });

  // ---- 5) SW's view of tabs -----------------------------------------------------
  const swTabs = JSON.parse(await cSw.evaluate(`Promise.resolve(chrome.tabs.query({})).then(function(t){
    return JSON.stringify(t.map(function(x){ return { id: x.id, url: x.url }; }));
  })`));
  rec('sw-tabs', swTabs);
  const realTabId = (swTabs.find((t) => t.url.indexOf(GUI_PREFIX) === 0) || {}).id;
  rec('real-tab-id', { realTabId });

  // ---- 6) panel tree click -> SW must use the REAL tab, top frame ---------------
  // The fresh SPA tab can take a few seconds to render the sidebar tree;
  // retry the click until the panel dropdown shows real rows (not the
  // 'sidebar isn't visible' error).
  let tree = null;
  let treeClicks = 0;
  for (;;) {
    await cPanel.evaluate(`document.getElementById('ws-tree-btn').click(); 'clicked'`);
    tree = await waitTreeSettled(cPanel);
    treeClicks++;
    if (tree.status !== 'error' && tree.body && tree.body.indexOf('isn\'t visible') === -1) break;
    if (treeClicks >= 6) throw new Error('tree never rendered rows; last: ' + JSON.stringify(tree));
    await sleep(2000);
  }
  rec('panel-tree', { ...tree, clicks: treeClicks, note: 'retries until the fresh SPA tab renders its sidebar rows' });
  const lastSend = JSON.parse(await cSw.evaluate(`JSON.stringify(self.__lastGuiSend)`));
  rec('sw-last-send', lastSend);
  rec('real-tab-preferred', {
    usedRealTab: lastSend.tabId === realTabId,
    frameIdAbsent: lastSend.frameId === undefined,
    type: lastSend.type,
  });
  await sleep(500);
  rec('real-tab-markers-after-click', { count: sinkReal.markers().length, note: 'unchanged => no executeScript fallback' });

  // ---- 7) overlay from the panel -> must land in the REAL tab DOM ---------------
  await cPanel.evaluate(`document.getElementById('ws-overlay-btn').click(); 'clicked'`);
  let ovStatus = null;
  for (let i = 0; i < 25; i++) {
    ovStatus = JSON.parse(await cPanel.evaluate(SHARE_STATUS_EXPR));
    if (ovStatus.text.indexOf('Workspace overlay') === 0 || ovStatus.text.indexOf('Overlay failed') === 0) break;
    await sleep(400);
  }
  rec('overlay-panel-status', ovStatus);
  const ovReal = JSON.parse(await cReal.evaluate(`(function(){
    var o = document.querySelector('[data-chrome-eye-overlay="true"]');
    if (!o) return JSON.stringify({ present: false });
    var body = o.querySelector('[data-ce-body]');
    return JSON.stringify({ present: true, bodyText: (body ? body.innerText : o.innerText).slice(0, 400) });
  })()`));
  const ovFrame = await cFrame.evaluate(`!!document.querySelector('[data-chrome-eye-overlay="true"]')`);
  rec('overlay-routing', { presentInRealTab: ovReal, presentInPanelIframe: ovFrame });

  await cReal.evaluate(`(function(){
    var o = document.querySelector('[data-chrome-eye-overlay="true"]');
    if (!o) return 'no-overlay';
    var bs = o.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) if (bs[i].textContent === '\\u2715') { bs[i].click(); return 'x-clicked'; }
    return 'no-close-btn';
  })()`);
  await sleep(600);
  rec('overlay-closed-in-real-tab', { present: await cReal.evaluate(`!!document.querySelector('[data-chrome-eye-overlay="true"]')`) });

  // ---- 8) share chip flow (panel iframe UI) --------------------------------------
  let chips = null;
  for (let i = 0; i < 20; i++) {
    chips = await cFrame.evaluate(`(function(){
      var r = document.querySelector('div[style*="2147483647"]');
      if (!r) return 'none';
      return 'present';
    })()`);
    if (chips === 'present') break;
    await sleep(500);
  }
  rec('chip-row-present', { chips });

  await cFrame.evaluate(`document.querySelector('div[style*="2147483647"] button[title="Add a tab as context"]').click(); 'plus'`);
  let picker = 'none';
  for (let i = 0; i < 20; i++) {
    picker = await cFrame.evaluate(`(function(){
      var dds = document.querySelectorAll('div[style*="2147483647"]');
      for (var i = 0; i < dds.length; i++) if (dds[i].innerText && dds[i].innerText.indexOf('3081/health') !== -1) return 'found';
      return 'none';
    })()`);
    if (picker === 'found') break;
    await sleep(400);
  }
  rec('picker', { picker });
  // Click the ENTRY LEAF div (the listener is on the leaf, not the
  // dropdown root — same fix as finish-panel.mjs).
  const entryClick = await cFrame.evaluate(`(function(){
    var dds = document.querySelectorAll('div[style*="2147483647"]');
    for (var i = 0; i < dds.length; i++) {
      if (!dds[i].innerText || dds[i].innerText.indexOf('3081/health') === -1) continue;
      var kids = dds[i].querySelectorAll(':scope > div');
      for (var k = 0; k < kids.length; k++) if (kids[k].innerText && kids[k].innerText.indexOf('3081/health') !== -1) { kids[k].click(); return 1; }
    }
    return 0;
  })()`);
  rec('picker-entry-click', { clicked: entryClick });
  let staged = null;
  for (let i = 0; i < 15; i++) {
    staged = JSON.parse(await cFrame.evaluate(`(function(){
      var r = document.querySelector('div[style*="2147483647"]');
      var go = null;
      var bs = r.querySelectorAll('button');
      for (var i = 0; i < bs.length; i++) if (bs[i].textContent.indexOf('add to session') !== -1) go = bs[i];
      return JSON.stringify({ staged: r.innerText.indexOf('3081/health') !== -1, goEnabled: go ? !go.disabled : null });
    })()`));
    if (staged.staged && staged.goEnabled) break;
    await sleep(400);
  }
  rec('staged', staged);

  const shareReqs = [];
  cSw.on('Network.requestWillBeSent', (e) => {
    if (e.request.url.indexOf('http://127.0.0.1:3081/share') === 0) shareReqs.push(e);
  });
  await cFrame.evaluate(`(function(){
    var r = document.querySelector('div[style*="2147483647"]');
    var bs = r.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) if (bs[i].textContent.indexOf('add to session') !== -1) { bs[i].click(); return 'go'; }
    return 'no-go';
  })()`);
  let req = null;
  for (let i = 0; i < 25 && !req; i++) { if (shareReqs.length) req = shareReqs[0]; await sleep(400); }
  if (!req) throw new Error('no :3081/share POST observed');
  const body = JSON.parse(req.request.postData || '{}');
  rec('share-post', {
    url: req.request.url, method: req.request.method,
    sessionId: body.sessionId,
    url: body.url, title: body.title, textLen: (body.visibleText || '').length, hasImage: !!body.image,
    note: 'single-page payload shape (sw.js composePayload); bridge reads visibleText',
  });
  rec('sw-capture-send', { lastSend: JSON.parse(await cSw.evaluate(`JSON.stringify(self.__lastGuiSend)`)), note: 'captureTab -> top frame of the staged real web tab (no frameId)' });

  await sleep(600);
  const chipStatus = await cFrame.evaluate(`(function(){
    var r = document.querySelector('div[style*="2147483647"]');
    return r ? r.innerText : '';
  })()`);
  rec('chip-row-final', { text: chipStatus });
  rec('panel-share-status', JSON.parse(await cPanel.evaluate(SHARE_STATUS_EXPR)));

  finish(0);
} catch (e) {
  rec('FATAL', { error: String(e && e.stack || e) });
  finish(1);
}
