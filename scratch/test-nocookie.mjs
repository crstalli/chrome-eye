// No-cookie graceful degradation test (fresh profile, NO :3080 cookie).
// The panel's :3080 iframe commits the 401 page; the panel-frame fallback engages
// and surfaces content.js 'sidebar-not-visible' texts. Captures EXACT user-facing
// strings. Also probes the first-click race (panel reload, click before commit).
// Writes scratch/results-nocookie.json.

import { readFileSync, writeFileSync } from 'node:fs';
import {
  sleep, waitForTarget, attach, makeConsoleSink,
  TREE_STATE_EXPR, SHARE_STATUS_EXPR, waitTreeSettled,
} from './lib-cdp.mjs';

const extId = readFileSync(new URL('./ext-id.txt', import.meta.url), 'utf8').trim();
const PANEL_URL = 'chrome-extension://' + extId + '/panel.html';
const GUI_PREFIX = 'http://127.0.0.1:3080/';

const results = { mode: 'no-cookie degradation (fresh profile)', steps: [] };
function rec(step, data) {
  results.steps.push({ step, data });
  const s = JSON.stringify(data, null, 1);
  console.log('== ' + step + ' ==\n' + (s.length > 3000 ? s.slice(0, 3000) + '\n…(truncated in log; full in results file)' : s));
}
function finish(code) {
  writeFileSync(new URL('./results-nocookie.json', import.meta.url), JSON.stringify(results, null, 1));
  console.log('\nRESULTS WRITTEN -> scratch/results-nocookie.json (' + results.steps.length + ' steps)');
  process.exit(code);
}

try {
  // ---- 1) open the panel tab ------------------------------------------------------
  const first = await waitForTarget((t) => t.type === 'page', 20000, 'first page');
  const cFirst = await attach(first, 'first');
  await cFirst.send('Target.createTarget', { url: PANEL_URL });
  const panel = await waitForTarget((t) => t.type === 'page' && t.url.indexOf('panel.html') !== -1, 15000, 'panel tab');
  cFirst.close();
  rec('panel-tab', { id: panel.id, url: panel.url });

  const cPanel = await attach(panel, 'panel');
  await cPanel.send('Runtime.enable');
  let ready = false;
  for (let i = 0; i < 40; i++) {
    ready = await cPanel.evaluate(`!!document.getElementById('ws-tree-btn')`);
    if (ready) break;
    await sleep(250);
  }
  rec('panel-ready', { ready });

  // ---- 2) wake + attach SW ----------------------------------------------------------
  await cPanel.evaluate(`Promise.resolve(chrome.runtime.sendMessage({type:'__probe-wake__'})).catch(function(){}); 'sent'`);
  const sw = await waitForTarget((t) => t.type === 'service_worker' && t.url.indexOf('chrome-extension://' + extId) !== -1, 15000, 'service worker (extension)');
  const cSw = await attach(sw, 'sw');
  await cSw.send('Runtime.enable');
  rec('sw-attached', { id: sw.id });

  // ---- 3) 401 iframe commits ---------------------------------------------------------
  const frame = await waitForTarget((t) => t.type === 'iframe' && t.url.indexOf(GUI_PREFIX) === 0, 30000, ':3080 iframe (401)');
  const cFrame = await attach(frame, 'iframe-401');
  await cFrame.send('Runtime.enable');
  const sink = makeConsoleSink();
  sink.hook(cFrame);

  let four = null;
  for (let i = 0; i < 30; i++) {
    four = JSON.parse(await cFrame.evaluate(`JSON.stringify({
      url: location.href,
      rs: document.readyState,
      bodyText: document.body ? document.body.innerText : ''
    })`));
    if (four.bodyText.indexOf('authentication required') !== -1) break;
    await sleep(500);
  }
  rec('iframe-401-committed', four);

  // ---- 4) tree click -> fallback injects into 401 page -> sidebar-not-visible ------
  const m0 = sink.markers().length;
  await cPanel.evaluate(`document.getElementById('ws-tree-btn').click(); 'clicked'`);
  const tree = await waitTreeSettled(cPanel);
  rec('tree-click-nocookie', tree);
  await sleep(800);
  rec('marker-after-click', { before: m0, after: sink.markers().length, delta: sink.markers().length - m0 });

  // ---- 5) overlay click in no-cookie mode --------------------------------------------
  await cPanel.evaluate(`document.getElementById('ws-overlay-btn').click(); 'clicked'`);
  let ovStatus = null;
  for (let i = 0; i < 25; i++) {
    ovStatus = JSON.parse(await cPanel.evaluate(SHARE_STATUS_EXPR));
    if (ovStatus.text.indexOf('Workspace overlay') === 0 || ovStatus.text.indexOf('Overlay failed') === 0) break;
    await sleep(400);
  }
  rec('overlay-panel-status', ovStatus);
  const ov = JSON.parse(await cFrame.evaluate(`(function(){
    var o = document.querySelector('[data-chrome-eye-overlay="true"]');
    if (!o) return JSON.stringify({ present: false });
    var body = o.querySelector('[data-ce-body]');
    return JSON.stringify({ present: true, bodyText: (body ? body.innerText : o.innerText).slice(0, 400) });
  })()`));
  rec('overlay-in-401-iframe', ov);

  // ---- 6) first-click race: reload panel, click tree before iframe commit ------------
  // (timing-dependent; report whichever error string actually appears)
  await cPanel.send('Page.enable');
  await cPanel.send('Page.reload');
  let raced = null;
  const t0 = Date.now();
  for (;;) {
    // panel re-rendered?
    let btn = false;
    try { btn = await cPanel.evaluate(`!!document.getElementById('ws-tree-btn')`); } catch { btn = false; }
    if (btn) break;
    if (Date.now() - t0 > 8000) throw new Error('panel did not re-render after reload');
    await sleep(150);
  }
  // click IMMEDIATELY
  try {
    await cPanel.evaluate(`document.getElementById('ws-tree-btn').click(); 'clicked'`);
  } catch (e) { raced = { error: 'click failed: ' + e.message }; }
  if (!raced) {
    try {
      raced = await waitTreeSettled(cPanel, 10000);
    } catch (e) {
      raced = { error: 'settle timeout: ' + e.message, state: JSON.parse(await cPanel.evaluate(TREE_STATE_EXPR)) };
    }
  }
  rec('first-click-race-after-reload', raced);

  finish(0);
} catch (e) {
  rec('FATAL', { error: String(e && e.stack || e) });
  finish(1);
}
