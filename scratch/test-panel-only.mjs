// Panel-only mode test with a minted :3080 cookie (fresh profile, no real tab).
// Drives the Chrome Eye panel via raw CDP against headless Chrome 152.
// Writes scratch/results-panel-only.json. Sequential; all fetches/CDP calls bounded.

import { readFileSync, writeFileSync } from 'node:fs';
import {
  sleep, listTargets, waitForTarget, attach, makeConsoleSink,
  TREE_STATE_EXPR, SHARE_STATUS_EXPR, waitTreeSettled,
} from './lib-cdp.mjs';

const extId = readFileSync(new URL('./ext-id.txt', import.meta.url), 'utf8').trim();
const PANEL_URL = 'chrome-extension://' + extId + '/panel.html';
const GUI_PREFIX = 'http://127.0.0.1:3080/';
const HEALTH_URL = 'http://127.0.0.1:3081/health';

const results = { mode: 'panel-only (cookie)', steps: [] };
function rec(step, data) {
  results.steps.push({ step, data });
  const s = JSON.stringify(data, null, 1);
  console.log('== ' + step + ' ==\n' + (s.length > 3500 ? s.slice(0, 3500) + '\n…(truncated in log; full in results file)' : s));
}
function finish(code) {
  writeFileSync(new URL('./results-panel-only.json', import.meta.url), JSON.stringify(results, null, 1));
  console.log('\nRESULTS WRITTEN -> scratch/results-panel-only.json (' + results.steps.length + ' steps)');
  process.exit(code);
}

try {
  // ---- 0) devtools up ------------------------------------------------------
  const first = await waitForTarget((t) => t.type === 'page', 20000, 'first page');
  rec('devtools-up', { firstUrl: first.url });

  // ---- 1) minted cookie into the profile ------------------------------------
  const cookie = JSON.parse(readFileSync(new URL('./minted-fresh.json', import.meta.url), 'utf8'));
  const cBlank = await attach(first, 'blank');
  await cBlank.send('Network.enable');
  const setRes = await cBlank.send('Network.setCookie', {
    url: GUI_PREFIX, name: cookie.name, value: cookie.value,
    httpOnly: true, sameSite: 'Strict', path: '/',
  });
  const got = await cBlank.send('Network.getCookies', { urls: [GUI_PREFIX] });
  rec('cookie-set', {
    success: !!setRes.success, name: cookie.name,
    present: (got.cookies || []).some((c) => c.name === cookie.name),
  });

  // ---- 2) open the share-target tab, then the panel tab ----------------------
  await cBlank.send('Target.createTarget', { url: HEALTH_URL });
  const health = await waitForTarget((t) => t.type === 'page' && t.url.indexOf('3081/health') !== -1, 15000, 'health tab');
  rec('health-tab', { id: health.id, url: health.url });

  await cBlank.send('Target.createTarget', { url: PANEL_URL });
  const panel = await waitForTarget((t) => t.type === 'page' && t.url.indexOf('panel.html') !== -1, 15000, 'panel tab');
  rec('panel-tab', { id: panel.id, url: panel.url });
  cBlank.close();

  // ---- 3) panel's :3080 iframe — attach + console capture BEFORE any click ---
  const frame = await waitForTarget((t) => t.type === 'iframe' && t.url.indexOf(GUI_PREFIX) === 0, 30000, ':3080 iframe');
  const cFrame = await attach(frame, 'iframe');
  await cFrame.send('Runtime.enable');
  const sinkFrame = makeConsoleSink();
  sinkFrame.hook(cFrame);

  let gui = null;
  for (let i = 0; i < 60; i++) {
    gui = JSON.parse(await cFrame.evaluate(`JSON.stringify({
      rs: document.readyState,
      centerCol: !!document.querySelector('[class*="_centerCol"]'),
      sidebar: !!document.querySelector('[class*="_groupSection"], [class*="_sessionRow"]'),
      title: document.title,
      is401: (document.body ? document.body.innerText : '').indexOf('authentication required') !== -1,
      bodyStart: (document.body ? document.body.innerText : '').replace(/\\s+/g, " ").slice(0, 160)
    })`));
    if (gui.centerCol || gui.sidebar) break;
    await sleep(500);
  }
  await sleep(1500); // let the sidebar finish rendering
  rec('iframe-gui-real-not-401', gui);

  // ---- 4) panel page ready ----------------------------------------------------
  const cPanel = await attach(panel, 'panel');
  await cPanel.send('Runtime.enable');
  let panelReady = false;
  for (let i = 0; i < 40; i++) {
    panelReady = await cPanel.evaluate(`!!document.getElementById('ws-tree-btn')`);
    if (panelReady) break;
    await sleep(250);
  }
  rec('panel-ready', { panelReady });

  // ---- 5) service worker: wake + attach (Network + Runtime) --------------------
  await cPanel.evaluate(`Promise.resolve(chrome.runtime.sendMessage({type:'__probe-wake__'})).catch(function(){}); 'sent'`);
  const sw = await waitForTarget((t) => t.type === 'service_worker' && t.url.indexOf('chrome-extension://' + extId) !== -1, 15000, 'service worker (extension)');
  const cSw = await attach(sw, 'sw');
  await cSw.send('Runtime.enable');
  await cSw.send('Network.enable');
  const sinkSw = makeConsoleSink();
  sinkSw.hook(cSw);
  rec('sw-attached', { id: sw.id });

  // ---- 6) TREE click #1 — first message must trigger executeScript fallback ----
  const m0 = sinkFrame.markers().length;
  await cPanel.evaluate(`document.getElementById('ws-tree-btn').click(); 'clicked'`);
  const tree1 = await waitTreeSettled(cPanel);
  rec('tree-click1-first', tree1);
  await sleep(1000);
  const m1 = sinkFrame.markers().length;
  rec('marker-after-click1', { before: m0, after: m1, delta: m1 - m0, note: 'delta=1 => executeScript fallback fired; delta=0 => live receiver' });

  // ---- 7) TREE click #2 — close + reopen, live receiver, no re-injection ------
  await cPanel.evaluate(`var b=document.getElementById('ws-tree-btn'); b.click(); b.click(); 'toggled'`);
  const tree2 = await waitTreeSettled(cPanel);
  rec('tree-click2-reopen', tree2);
  await sleep(800);
  const m2 = sinkFrame.markers().length;
  rec('marker-after-click2', { after: m2, delta: m2 - m1, note: 'delta=0 => live content script answered (no re-injection)' });

  // ---- 8) guiSessionId: GUI draft -> content poller -> SW cache -> share payload
  // (empty profile => no session rows => tree stays sidebar-not-visible, so the
  //  SW-cache footer can't render; read the SW's guiSessionId directly instead)
  const readSwSess = async (label) => {
    const v = await cSw.evaluate(`(function(){ try { return typeof guiSessionId !== 'undefined' ? String(guiSessionId) : 'UNDEFINED'; } catch (e) { return 'READ-ERR: ' + e.message; } })()`);
    rec(label, { swGuiSessionId: v });
    return v;
  };
  const sessBeforeFake = await readSwSess('sw-guiSessionId-before-fake');
  await cFrame.evaluate(`localStorage.setItem('dsh.sessions.current', JSON.stringify({sessionId:'fake-sess-123'})); 'set'`);
  await sleep(3200); // >= one 2s poll tick
  const sessAfterFake = await readSwSess('sw-guiSessionId-after-fake');
  rec('fakesession-flow', {
    beforeFake: sessBeforeFake,
    afterFake: sessAfterFake,
    fakeReachedSwCache: sessAfterFake === 'fake-sess-123',
  });

  // ---- 9) SHARE via the chip row in the iframe ----------------------------------
  let chips = null;
  for (let i = 0; i < 20; i++) {
    chips = await cFrame.evaluate(`(function(){
      var r = document.querySelector('div[style*="2147483647"]');
      if (!r) return 'none';
      return JSON.stringify({ exists: true, text: r.innerText.slice(0, 200) });
    })()`);
    if (chips !== 'none') break;
    await sleep(500);
  }
  rec('chip-row-present', JSON.parse(chips));

  await cFrame.evaluate(`document.querySelector('div[style*="2147483647"] button[title="Add a tab as context"]').click(); 'plus'`);
  let picker = null;
  for (let i = 0; i < 20; i++) {
    picker = await cFrame.evaluate(`(function(){
      var dds = document.querySelectorAll('div[style*="2147483647"]');
      for (var i = 0; i < dds.length; i++) {
        if (dds[i].innerText && dds[i].innerText.indexOf('3081/health') !== -1) {
          return JSON.stringify({ found: true, text: dds[i].innerText.slice(0, 160) });
        }
      }
      return 'none';
    })()`);
    if (picker !== 'none') break;
    await sleep(400);
  }
  rec('picker-entry', JSON.parse(picker));

  const entryClick = await cFrame.evaluate(`(function(){
    var dds = document.querySelectorAll('div[style*="2147483647"]');
    for (var i = 0; i < dds.length; i++) {
      if (!dds[i].innerText || dds[i].innerText.indexOf('3081/health') === -1) continue;
      var els = dds[i].querySelectorAll('div');
      var leaf = null; // last (deepest) div in document order containing the url
      for (var j = 0; j < els.length; j++) if (els[j].textContent.indexOf('3081/health') !== -1) leaf = els[j];
      if (leaf) { leaf.click(); return 'clicked-entry'; }
    }
    return 'no-entry';
  })()`);
  rec('entry-clicked', { entryClick });

  let staged = null;
  for (let i = 0; i < 15; i++) {
    staged = JSON.parse(await cFrame.evaluate(`(function(){
      var r = document.querySelector('div[style*="2147483647"]');
      var go = null;
      var bs = r.querySelectorAll('button');
      for (var i = 0; i < bs.length; i++) if (bs[i].textContent.indexOf('add to session') !== -1) go = bs[i];
      return JSON.stringify({ staged: r.innerText.indexOf('3081/health') !== -1, goEnabled: go ? !go.disabled : null, text: r.innerText.slice(0, 200) });
    })()`));
    if (staged.staged && staged.goEnabled) break;
    await sleep(400);
  }
  rec('staged', staged);

  const shareReqs = [];
  const shareResps = {};
  cSw.on('Network.requestWillBeSent', (e) => {
    if (e.request.url.indexOf('http://127.0.0.1:3081/share') === 0) shareReqs.push(e);
  });
  cSw.on('Network.responseReceived', (e) => {
    if (e.requestId in shareReqs.map((r) => r.requestId)) shareResps[e.requestId] = e;
  });

  const goClick = await cFrame.evaluate(`(function(){
    var r = document.querySelector('div[style*="2147483647"]');
    var bs = r.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) if (bs[i].textContent.indexOf('add to session') !== -1) { bs[i].click(); return 'go-clicked'; }
    return 'no-go';
  })()`);
  rec('go-clicked', { goClick });

  let req = null;
  for (let i = 0; i < 25 && !req; i++) { if (shareReqs.length) req = shareReqs[0]; await sleep(400); }
  if (!req) throw new Error('no :3081/share POST observed on the SW within 10s');
  rec('share-post', {
    url: req.request.url, method: req.request.method,
    headers: req.request.headers,
    body: req.request.postData,
    bodyContainsFakeSession: (req.request.postData || '').indexOf('fake-sess-123') !== -1,
    bodyContainsHealthUrl: (req.request.postData || '').indexOf('127.0.0.1:3081/health') !== -1,
  });

  // bridge response
  let respMeta = null;
  for (let i = 0; i < 20 && !respMeta; i++) {
    if (shareResps[req.requestId]) respMeta = shareResps[req.requestId];
    await sleep(400);
  }
  let respBody = null;
  if (respMeta) {
    await sleep(400);
    try {
      const rb = await cSw.send('Network.getResponseBody', { requestId: req.requestId });
      respBody = rb.body;
    } catch (e) { respBody = 'unreadable: ' + e.message; }
  }
  rec('share-bridge-response', {
    status: respMeta ? respMeta.response.status : null,
    statusText: respMeta ? respMeta.response.statusText : null,
    mimeType: respMeta ? respMeta.response.mimeType : null,
    body: respBody,
  });

  await sleep(600);
  const chipStatus = await cFrame.evaluate(`(function(){
    var r = document.querySelector('div[style*="2147483647"]');
    return r ? r.innerText : '';
  })()`);
  rec('chip-row-final', { text: chipStatus });
  rec('panel-share-status', JSON.parse(await cPanel.evaluate(SHARE_STATUS_EXPR)));
  rec('sw-console-share', {
    sharePayloadLogs: sinkSw.arr.filter((e) => e.text.indexOf('Chrome Eye share payload') !== -1).length,
  });

  // ---- 10) OVERLAY in panel-only mode ------------------------------------------
  await cPanel.evaluate(`document.getElementById('ws-overlay-btn').click(); 'clicked'`);
  let ovStatus = null;
  for (let i = 0; i < 25; i++) {
    ovStatus = JSON.parse(await cPanel.evaluate(SHARE_STATUS_EXPR));
    if (ovStatus.text.indexOf('Workspace overlay') === 0 || ovStatus.text.indexOf('Overlay failed') === 0) break;
    await sleep(400);
  }
  rec('overlay-panel-status', ovStatus);

  const ovInIframe = JSON.parse(await cFrame.evaluate(`(function(){
    var o = document.querySelector('[data-chrome-eye-overlay="true"]');
    if (!o) return JSON.stringify({ present: false });
    var body = o.querySelector('[data-ce-body]');
    return JSON.stringify({ present: true, bodyText: (body ? body.innerText : o.innerText).slice(0, 400) });
  })()`));
  rec('overlay-in-panel-iframe', ovInIframe);

  const closeRes = await cFrame.evaluate(`(function(){
    var o = document.querySelector('[data-chrome-eye-overlay="true"]');
    if (!o) return 'no-overlay';
    var bs = o.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) if (bs[i].textContent === '\\u2715') { bs[i].click(); return 'x-clicked'; }
    return 'no-close-btn';
  })()`);
  await sleep(600);
  rec('overlay-closed', {
    closeRes,
    present: await cFrame.evaluate(`!!document.querySelector('[data-chrome-eye-overlay="true"]')`),
  });

  rec('iframe-markers-final', { count: sinkFrame.markers().length });
  finish(0);
} catch (e) {
  rec('FATAL', { error: String(e && e.stack || e) });
  finish(1);
}
