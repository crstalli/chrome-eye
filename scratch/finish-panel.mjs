// Combined Issue B + Issue A re-verification (panel-only, minted cookie).
//
// Key addition vs test-panel-only.mjs: a background watcher polls /json/list
// every 700ms and records EVERY service-worker target-id change with a
// timestamp, so a silent MV3 SW restart is no longer invisible. Before every
// SW read and before the go-click we RE-RESOLVE the SW target and re-attach
// when the id changed (stale CDP attachments die silently).
//
// Issue A evidence = POST body contains sessionId 'fake-xyz' (+ SW var reads
// as scope canaries: typeof guiSessionId / SHARE_ENDPOINT / stagedTabs).
// Issue B evidence = :3081/share POST observed on the CURRENT SW target
// within 15s of go, + chip status text + SW console lines.
//
// Writes scratch/results-finish-panel.json.
import { readFileSync, writeFileSync } from 'node:fs';
import {
  sleep, listTargets, waitForTarget, attach, makeConsoleSink,
  TREE_STATE_EXPR, SHARE_STATUS_EXPR, waitTreeSettled,
} from './lib-cdp.mjs';

const GUI_PREFIX = 'http://127.0.0.1:3080/';

const extId = readFileSync(new URL('./ext-id.txt', import.meta.url), 'utf8').trim();
const cookie = JSON.parse(readFileSync(new URL('./minted-fresh.json', import.meta.url), 'utf8'));
const PANEL_URL = 'chrome-extension://' + extId + '/panel.html';
const HEALTH_URL = 'http://127.0.0.1:3081/health';
const FAKE_ID = 'fake-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

const results = { mode: 'panel-only rerun (Issue B + Issue A)', extId, steps: [], swTimeline: [] };
function rec(step, data) {
  results.steps.push({ step, data });
  const s = JSON.stringify(data, null, 1);
  console.log('== ' + step + ' ==\n' + (s.length > 2500 ? s.slice(0, 2500) + '\n…(truncated in log; full in results file)' : s));
}
function finish(code) {
  watcherAlive = false;
  writeFileSync(new URL('./results-finish-panel.json', import.meta.url), JSON.stringify(results, null, 1));
  console.log('\nRESULTS WRITTEN -> scratch/results-finish-panel.json (' + results.steps.length + ' steps, ' + results.swTimeline.length + ' sw-id events)');
  process.exit(code);
}

// ---- SW target-id timeline ----------------------------------------------------
let watcherAlive = true;
let lastSwId = null;
(async function watcher() {
  const t0 = Date.now();
  while (watcherAlive) {
    try {
      const list = await listTargets();
      const sw = list.find((t) => t.type === 'service_worker' && t.url.indexOf('chrome-extension://' + extId) !== -1);
      const id = sw ? sw.id : null;
      if (id !== lastSwId) {
        results.swTimeline.push({ t: Date.now() - t0, id, note: id ? (lastSwId ? 'RESTARTED (new id)' : 'appeared') : 'gone (SW idle-terminated)' });
        lastSwId = id;
        console.log('  [sw-timeline t=' + (Date.now() - t0) + 'ms] ' + (id ? 'SW id ' + String(id).slice(0, 12) + ' ' + (id === lastSwId ? '' : '') : 'SW gone') );
      }
    } catch { /* keep going */ }
    await sleep(700);
  }
})();

// SW attach helper: resolves the CURRENT sw target, re-attaches on id change.
let cSw = null;
let cSwId = null;
const swSinks = [];
async function ensureSw(label) {
  const list = await listTargets();
  const sw = list.find((t) => t.type === 'service_worker' && t.url.indexOf('chrome-extension://' + extId) !== -1);
  if (!sw) throw new Error(label + ': no service_worker target right now');
  if (cSw && sw.id === cSwId) return cSw;
  if (cSw) { try { cSw.close(); } catch { /* ignore */ } }
  cSw = await attach(sw, 'sw@' + String(sw.id).slice(0, 8) + '-' + label);
  cSwId = sw.id;
  await cSw.send('Runtime.enable');
  await cSw.send('Network.enable');
  const sink = makeConsoleSink();
  sink.hook(cSw);
  swSinks.push({ id: sw.id, sink });
  return cSw;
}

const CANARY = `JSON.stringify({
  tGui: (function(){ try { return typeof guiSessionId; } catch(e){ return 'ERR'; } })(),
  tEnd: (function(){ try { return typeof SHARE_ENDPOINT; } catch(e){ return 'ERR'; } })(),
  tStaged: (function(){ try { return typeof stagedTabs; } catch(e){ return 'ERR'; } })(),
  gui: (function(){ try { return (typeof guiSessionId !== 'undefined') ? guiSessionId : 'INVISIBLE'; } catch(e){ return 'ERR'; } })(),
  selfGui: (typeof self.guiSessionId !== 'undefined') ? self.guiSessionId : 'INVISIBLE',
  selfChrome: (typeof self.chrome !== 'undefined'),
  hasOwn: ['guiSessionId','stagedTabs','panelOpen','SHARE_ENDPOINT','findGuiTab'].map(function(k){ return k + ':' + Object.prototype.hasOwnProperty.call(self, k); })
})`;

try {
  const T0 = Date.now();
  const rel = () => Date.now() - T0;

  // ---- 1) cookie on a page target ---------------------------------------------
  const first = await waitForTarget((t) => t.type === 'page', 20000, 'first page');
  const cFirst = await attach(first, 'first');
  await cFirst.send('Network.enable');
  await cFirst.send('Network.setCookie', {
    url: 'http://127.0.0.1:3080', name: cookie.name, value: cookie.value,
    httpOnly: true, sameSite: 'Strict', path: '/',
  });
  rec('cookie-set', { name: cookie.name, t: rel() });
  await cFirst.send('Target.createTarget', { url: HEALTH_URL });
  await cFirst.send('Target.createTarget', { url: PANEL_URL });
  await sleep(2500);
  cFirst.close();

  // ---- 2) panel + iframe --------------------------------------------------------
  const panel = await waitForTarget((t) => t.type === 'page' && t.url.indexOf('panel.html') !== -1, 15000, 'panel tab');
  const cPanel = await attach(panel, 'panel');
  await cPanel.send('Runtime.enable');
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    ready = await cPanel.evaluate(`!!document.getElementById('ws-tree-btn')`);
    if (!ready) await sleep(250);
  }
  rec('panel-ready', { ready, t: rel() });

  const frame = await waitForTarget((t) => t.type === 'iframe' && t.url.indexOf(GUI_PREFIX) === 0, 30000, ':3080 iframe');
  const cFrame = await attach(frame, 'iframe');
  await cFrame.send('Runtime.enable');
  const sink = makeConsoleSink();
  sink.hook(cFrame);
  let gui = null;
  for (let i = 0; i < 60; i++) {
    gui = JSON.parse(await cFrame.evaluate(`JSON.stringify({
      rs: document.readyState,
      centerCol: !!document.querySelector('[class*="_centerCol"]'),
      sidebar: !!document.querySelector('[class*="_groupSection"], [class*="_sessionRow"]'),
      is401: (document.body ? document.body.innerText : '').indexOf('authentication required') !== -1
    })`));
    if ((gui.centerCol || gui.sidebar) && !gui.is401) break;
    await sleep(500);
  }
  await sleep(1200);
  rec('iframe-real-gui', gui);

  // ---- 3) wake + attach SW, scope canary -----------------------------------------
  await cPanel.evaluate(`Promise.resolve(chrome.runtime.sendMessage({type:'__probe-wake__'})).catch(function(){}); 'sent'`);
  await ensureSw('wake');
  rec('sw-attached', { id: cSwId, t: rel() });
  let canary = null;
  for (let i = 0; i < 10; i++) {
    canary = JSON.parse(await cSw.evaluate(CANARY));
    if (canary.tGui !== 'ERR') break;
    await sleep(500);
  }
  rec('sw-scope-canary', canary);

  // ---- 3b) SW state prep: guarantee panelOpen=true, clear stale guiSessionId -------
  const PREP = `JSON.stringify({
     panelOpen: (function(){ try { return panelOpen; } catch(e){ return 'ERR'; } })(),
     gui: (function(){ try { return guiSessionId; } catch(e){ return 'ERR'; } })(),
     staged: (function(){ try { return stagedTabs.length; } catch(e){ return 'ERR'; } })()
   })`;
  let prep = JSON.parse(await cSw.evaluate(PREP));
  if (prep.panelOpen !== true) {
    await cPanel.evaluate(`chrome.runtime.sendMessage({type:'chrome-eye:panel-open'}, function(){ void chrome.runtime.lastError; }); 'panel-open re-sent'`);
    await sleep(800);
  }
  await cSw.evaluate(`guiSessionId = ''; 'cleared'`);
  prep = JSON.parse(await cSw.evaluate(PREP));
  rec('sw-state-prep', prep);

  // ---- 4) tree click 1 + 2 (relays through the SW) --------------------------------
  const m0 = sink.markers().length;
  await cPanel.evaluate(`document.getElementById('ws-tree-btn').click(); 'clicked'`);
  const tree1 = await waitTreeSettled(cPanel);
  rec('tree-click1', { tree: tree1, markerDelta: sink.markers().length - m0, t: rel() });

  const m1 = sink.markers().length;
  await cPanel.evaluate(`var b=document.getElementById('ws-tree-btn'); b.click(); b.click(); 'toggled'`);
  const tree2 = await waitTreeSettled(cPanel);
  rec('tree-click2-reopen', { tree: tree2, markerDelta: sink.markers().length - m1, markerDeltaTotal: sink.markers().length - m0, note: 'delta=0 => live content script answered (no re-injection)', t: rel() });

  // ---- 5) Issue A: correctly-shaped fake session ----------------------------------
  await cFrame.evaluate(`localStorage.setItem('dsh.sessions.current', JSON.stringify({sessionId:'${FAKE_ID}'})); 'set'`);
  rec('fake-session-set', { value: FAKE_ID, shape: 'JSON {sessionId}', t: rel() });
  const samples = [];
  for (let i = 0; i < 7; i++) {
    await sleep(1000);
    try {
      const c = await ensureSw('fake-sample' + i);
      const s = JSON.parse(await c.evaluate(CANARY));
      samples.push({ t: rel(), swId: String(cSwId).slice(0, 12), tGui: s.tGui, gui: s.gui, selfGui: s.selfGui });
    } catch (e) {
      samples.push({ t: rel(), error: String(e && e.message || e) });
    }
  }
  rec('guiSessionId-samples-after-fake', samples);

  // ---- 6) stage the health tab chip -----------------------------------------------
  for (let i = 0; ; i++) {
    try {
      await cFrame.evaluate(`document.querySelector('div[style*="2147483647"] button[title="Add a tab as context"]').click(); 'plus'`);
      break;
    } catch (e) {
      if (i >= 24) throw new Error('chip strip never appeared (panelOpen?): ' + e.message);
      await sleep(400);
    }
  }
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
  await cFrame.evaluate(`(function(){
    var dds = document.querySelectorAll('div[style*="2147483647"]');
    for (var i = 0; i < dds.length; i++) {
      if (!dds[i].innerText || dds[i].innerText.indexOf('3081/health') === -1) continue;
      var dd = dds[i];
      // the click listener lives on the ENTRY leaf (cursor:pointer child), not the dd root
      var kids = dd.querySelectorAll(':scope > div');
      for (var k = 0; k < kids.length; k++) if (kids[k].innerText && kids[k].innerText.indexOf('3081/health') !== -1) { kids[k].click(); return 1; }
      dd.click(); return 2;
    }
    return 0;
  })()`);
  let staged = null;
  for (let i = 0; i < 15; i++) {
    staged = JSON.parse(await cFrame.evaluate(`(function(){
      var r = document.querySelector('div[style*="2147483647"]');
      if (!r) return JSON.stringify({ staged: false, goEnabled: null });
      var go = null;
      var bs = r.querySelectorAll('button');
      for (var i = 0; i < bs.length; i++) if (bs[i].textContent.indexOf('add to session') !== -1) go = bs[i];
      return JSON.stringify({ staged: r.innerText.indexOf('3081/health') !== -1, goEnabled: go ? !go.disabled : null });
    })()`));
    if (staged.staged && staged.goEnabled) break;
    await sleep(400);
  }
  rec('staged', staged);

  // ---- 7) Issue B: go-click with FRESH SW capture ----------------------------------
  async function chipRowText() {
    const t = await cFrame.evaluate(`(function(){
      var r = document.querySelector('div[style*="2147483647"]');
      return r ? r.innerText : 'NO-CHIP-ROOT';
    })()`);
    return t;
  }

  async function doGo(attempt) {
    const c = await ensureSw('go' + attempt);
    const swIdAtGo = String(cSwId);
    const shareReqs = [];
    const responses = {};
    c.on('Network.requestWillBeSent', (e) => {
      if (e.request.url.indexOf('http://127.0.0.1:3081/share') === 0) shareReqs.push(e);
    });
    c.on('Network.responseReceived', (e) => {
      const rurl = (e.response && e.response.url) || e.url || '';
      if (e.requestId && rurl.indexOf('http://127.0.0.1:3081/share') === 0) responses[e.requestId] = e.response;
    });
    const click = await cFrame.evaluate(`(function(){
      var r = document.querySelector('div[style*="2147483647"]');
      if (!r) return 'no-root';
      var bs = r.querySelectorAll('button');
      for (var i = 0; i < bs.length; i++) if (bs[i].textContent.indexOf('add to session') !== -1) { if (bs[i].disabled) return 'disabled'; bs[i].click(); return 'go'; }
      return 'no-go';
    })()`);
    if (click !== 'go') return { click, shareReqs: [], swIdAtGo };
    let req = null;
    for (let i = 0; i < 40 && !req; i++) { if (shareReqs.length) req = shareReqs[0]; await sleep(400); }
    let respBody = null;
    if (req) {
      for (let i = 0; i < 10; i++) {
        if (responses[req.requestId]) {
          try {
            const body = await c.send('Network.getResponseBody', { requestId: req.requestId });
            respBody = body.body;
          } catch (e) { respBody = 'read-failed: ' + e.message; }
          break;
        }
        await sleep(300);
      }
    }
    await sleep(800);
    return {
      click, swIdAtGo,
      postObserved: !!req,
      post: req ? { url: req.request.url, method: req.request.method, postData: req.request.postData } : null,
      httpResponse: req && responses[req.requestId] ? { status: responses[req.requestId].status } : null,
      httpBody: respBody,
      chipText: await chipRowText(),
      panelShareStatus: JSON.parse(await cPanel.evaluate(SHARE_STATUS_EXPR)),
    };
  }

  let go = await doGo(1);
  rec('go-click-1', go);
  if (go.click === 'go' && !go.postObserved && /no staged pages/.test(go.chipText || '')) {
    // SW restarted between staging and go -> re-stage on the fresh SW and retry once.
    rec('note', { reason: 'chip says "no staged pages" -> SW restarted (stagedTabs lost); re-staging and retrying', swTimelineSoFar: results.swTimeline.length });
    await cFrame.evaluate(`document.querySelector('div[style*="2147483647"] button[title="Add a tab as context"]').click(); 'plus'`);
    await sleep(1500);
    await cFrame.evaluate(`(function(){
      var dds = document.querySelectorAll('div[style*="2147483647"]');
      for (var i = 0; i < dds.length; i++) if (dds[i].innerText && dds[i].innerText.indexOf('3081/health') !== -1) { dds[i].click(); return 1; }
      return 0;
    })()`);
    await sleep(1500);
    go = await doGo(2);
    rec('go-click-2-retry', go);
  }

  // ---- 8) SW console evidence + final var read -------------------------------------
  const swLines = [];
  for (const entry of swSinks) {
    for (const l of entry.sink.arr) {
      if (l.text.indexOf('Chrome Eye') !== -1 || l.text.indexOf('share') !== -1 || l.text.indexOf('payload') !== -1 || l.text.indexOf('capture') !== -1) {
        swLines.push({ sw: String(entry.id).slice(0, 8), type: l.type, text: l.text.slice(0, 400) });
      }
    }
  }
  rec('sw-console-chrome-eye-lines', swLines);

  // ---- 8b) exercise the sharePage log path (panel share handler) -------------------
  // The chip flow uses shareTab (no console.log). Trigger the chrome-eye:share-page
  // handler so sw.js:233/239 log lines land in the sink as pipeline evidence.
  let probe = null;
  try {
    probe = JSON.parse(await (await ensureSw('logprobe')).evaluate(`(function(){
      // Activate the health tab (sharePage needs a web active tab) and call
      // the same handler the panel share button uses.
      return new Promise(function (res) {
        chrome.tabs.query({ url: 'http://127.0.0.1:3081/*' }, function (tabs) {
          if (!tabs || !tabs.length) { res(JSON.stringify({ error: 'no health tab' })); return; }
          chrome.tabs.update(tabs[0].id, { active: true }, function () {
            sharePage().then(
              function (r) { res(JSON.stringify(r)); },
              function (e) { res(JSON.stringify({ ok: false, error: String((e && e.message) || e) })); }
            );
          });
        });
      });
    })()`));
  } catch (e) { probe = { error: String(e) }; }
  rec('share-page-log-probe', probe);
  await sleep(500);

  const swLines2 = [];
  for (const entry of swSinks) {
    for (const l of entry.sink.arr) {
      if (l.text.indexOf('Chrome Eye') !== -1 || l.text.indexOf('share') !== -1 || l.text.indexOf('payload') !== -1 || l.text.indexOf('capture') !== -1) {
        swLines2.push({ sw: String(entry.id).slice(0, 8), type: l.type, text: l.text.slice(0, 400) });
      }
    }
  }
  rec('sw-console-chrome-eye-lines-final', swLines2);

  const cFin = await ensureSw('final');
  rec('final-sw-read', JSON.parse(await cFin.evaluate(CANARY)));
  rec('sw-timeline-final', { events: results.swTimeline });

  finish(0);
} catch (e) {
  rec('FATAL', { error: String(e && e.stack || e), swTimeline: results.swTimeline });
  finish(1);
}
