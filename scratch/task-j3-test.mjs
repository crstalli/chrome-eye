#!/usr/bin/env node
// Task J3 verification — headless Chrome on 9222, extension
// mlolgaoijponghgfnlcljlohnhlpnhkd. Proves:
//   J3-1  #ts-current-btn "Add current tab" exists, is the FIRST child of
//         #stage-row, styled with the dark-green token (color rgb(86,211,100)).
//   J3-2  Clicking it stages + adds the ACTIVE web tab (A) via the existing
//         SW messages: share-status ok, the SW-side shareTab wrapper records
//         exactly one share with id/url == A, stagedTabs cleared, chips 0.
//   J3-3  The existing Task H "Add tabs" list still works: stage B from the
//         dropdown, #ts-add → a second share is recorded with id/url == B,
//         chips cleared. The dropdown row for the active tab carries the
//         "· current tab" marker.
//   Screenshot with the dropdown open → /tmp/task-j3-panel.png.
//
// Session isolation (so add-staged takes the FALLBACK path — "Saved N page
// (no session open)" — instead of injecting test pages into a real DSH
// session): close the top-level :3081 GUI page (one reporter), clear
// dsh.sessions.current from the shared :3081-origin localStorage (the
// panel-iframe reporter), then set the SW global guiSessionId = null and
// verify it stays null. If a reporter re-caches it, a test-only wrapper
// strips sessionId from composePayload output (deterministic fallback guard,
// noted in evidence).
const BASE = 'http://127.0.0.1:9222';
const EXT_ID = 'mlolgaoijponghgfnlcljlohnhlpnhkd';
const PANEL_URL = `chrome-extension://${EXT_ID}/panel.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = await import('node:fs');

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = []; }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const cdp = new Cdp(ws);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString()); } catch { return; }
      if (msg.id && cdp.pending.has(msg.id)) {
        const p = cdp.pending.get(msg.id);
        clearTimeout(p.timer); cdp.pending.delete(msg.id);
        msg.error ? p.reject(new Error('CDP ' + msg.error.message)) : p.resolve(msg.result);
      } else if (!msg.id) { for (const h of cdp.handlers) { try { h(msg); } catch {} } }
    };
    return cdp;
  }
  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = ++this.id;
    const e = { id, method, params };
    if (sessionId) e.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(e));
    });
  }
  on(h) { this.handlers.push(h); }
  close() { try { this.ws.close(); } catch {} }
}

const E = { steps: [], pass: true, fails: [], notes: [] };
function check(name, cond, detail) {
  E.steps.push({ name, pass: !!cond, detail: detail === undefined ? '' : detail });
  if (!cond) { E.pass = false; E.fails.push(name); }
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).substring(0, 240) : ''));
}
function note(k, v) { E.notes.push({ k, v }); console.log('NOTE ' + k + ': ' + JSON.stringify(v).substring(0, 240)); }

async function main() {
  const ver = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(3000) });
  const cdp = await Cdp.connect((await ver.json()).webSocketDebuggerUrl);
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  const ev = async (sess, expr, timeoutMs = 25000) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sess, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text;
      throw new Error('eval exception: ' + String(d).substring(0, 300));
    }
    return r.result ? r.result.value : undefined;
  };
  const listTargets = async () => (await cdp.send('Target.getTargets')).targetInfos;
  const msgFromPanel = (sp, type, extra) =>
    ev(sp, `new Promise(function (r) { chrome.runtime.sendMessage(${JSON.stringify(Object.assign({ type }, extra || {}))}, function (res) { r(JSON.stringify(res)); }); })`);

  // ---------- 1. web tabs A + B (reuse J1's, else create) ----------
  let ts = await listTargets();
  const findTab = (url) => ts.find((x) => x.type === 'page' && x.url === url);
  let A = findTab('http://127.0.0.1:9222/json/version');
  let B = findTab('http://127.0.0.1:9222/json');
  if (!A) A = { targetId: (await cdp.send('Target.createTarget', { url: 'http://127.0.0.1:9222/json/version' })).targetId };
  if (!B) B = { targetId: (await cdp.send('Target.createTarget', { url: 'http://127.0.0.1:9222/json' })).targetId };
  await sleep(2000);
  note('webTabs', { A: A.targetId, B: B.targetId, Aurl: 'http://127.0.0.1:9222/json/version', Burl: 'http://127.0.0.1:9222/json' });

  // ---------- 2. close stale panel + top-level :3081 GUI page (isolation) ----------
  ts = await listTargets();
  for (const t of ts.filter((x) => x.type === 'page' && x.url === PANEL_URL)) {
    await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
    note('closedStalePanel', t.targetId);
  }
  for (const t of ts.filter((x) => x.type === 'page' && x.url && x.url.indexOf('127.0.0.1:3081') !== -1)) {
    await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
    note('closedGuiPage', t.targetId);
  }
  await sleep(1000);

  // ---------- 3. fresh panel target (loads the edited panel.html/panel.js) ----------
  const P = (await cdp.send('Target.createTarget', { url: PANEL_URL })).targetId;
  const att = await cdp.send('Target.attachToTarget', { targetId: P, flatten: true });
  const sp = att.sessionId;
  await cdp.send('Runtime.enable', {}, sp);
  await cdp.send('Page.enable', {}, sp);
  for (let i = 0; i < 40 && (await ev(sp, 'document.readyState').catch(() => '')) !== 'complete'; i++) await sleep(500);
  note('panelTarget', P);

  // ---------- 4. attach to the service worker (wake it if idle) ----------
  let swTarget = null;
  for (let i = 0; i < 24; i++) {
    ts = await listTargets();
    swTarget = ts.find((x) => x.type === 'service_worker' && x.url && x.url.indexOf(EXT_ID) !== -1) || null;
    if (swTarget) break;
    await msgFromPanel(sp, 'chrome-eye:panel-state').catch(() => {});
    await sleep(500);
  }
  check('SW target found', !!swTarget, swTarget ? swTarget.url : 'missing after 12s of wakes');
  if (!swTarget) throw new Error('no service_worker target');
  const sw = (await cdp.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).sessionId;
  await cdp.send('Runtime.enable', {}, sw);

  // ---------- 5. read SW state ----------
  const swState = JSON.parse(await ev(sw, 'JSON.stringify({ staged: stagedTabs, gui: guiSessionId, panelOpen: panelOpen })'));
  note('swInitialState', swState);

  // ---------- 6. session isolation: force the fallback path ----------
  // 6a. clear dsh.sessions.current from the panel iframe's :3081-origin storage
  ts = await listTargets();
  const iframe = ts.find((x) => x.type === 'iframe' && x.url && x.url.indexOf('127.0.0.1:3081') !== -1) || null;
  if (iframe) {
    const si = (await cdp.send('Target.attachToTarget', { targetId: iframe.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, si);
    const cleared = await ev(si, `try { localStorage.removeItem('dsh.sessions.current'); 'cleared' } catch (e) { 'ERR:' + e.message }`).catch(() => 'ev-err');
    note('lsCurrentCleared', cleared);
  } else {
    note('lsCurrentCleared', 'no :3081 iframe target yet');
  }
  // 6b. null the SW cache (only non-empty reports ever re-cache it, and the
  //     reporters are now gone)
  await ev(sw, 'guiSessionId = null; "nulled"');
  await sleep(3000);
  let guiAfter = await ev(sw, 'String(guiSessionId)');
  let guard = false;
  if (guiAfter !== 'null' && guiAfter !== 'undefined') {
    // defensive: strip sessionId from every composed payload (deterministic
    // fallback no matter what re-caches the id)
    guard = await ev(sw, `(function () {
      if (self.__j3cpGuard) return 'already';
      self.__j3cpGuard = true;
      var orig = self.composePayload;
      self.composePayload = function () {
        var p = orig.apply(self, arguments);
        if (p && typeof p === 'object') { delete p.sessionId; }
        return p;
      };
      return 'applied';
    })()`);
    note('composePayloadGuard', guard);
  }
  check('session isolation (guiSessionId null)', guiAfter === 'null' || guiAfter === 'undefined' || guard === 'applied', { guiAfter, guard });

  // ---------- 7. unstage any leftovers → 0 chips ----------
  if (swState.staged && swState.staged.length) {
    for (const t of swState.staged) {
      await msgFromPanel(sp, 'chrome-eye:unstage-tab', { tabId: t.id }).catch(() => {});
    }
    await sleep(2500);
  }
  const stagedNow = JSON.parse(await ev(sw, 'JSON.stringify(stagedTabs)'));
  const chipsNow = await ev(sp, `document.getElementById('ts-chips').querySelectorAll('.ts-chip').length`);
  check('staging clean slate', stagedNow.length === 0 && chipsNow === 0, { stagedTabs: stagedNow, chips: chipsNow });

  // ---------- 8. wrap SW shareTab → record every shared tab ----------
  const wrap = await ev(sw, `(function () {
    if (self.__j3Wrapped) { return 'already'; }
    self.__j3 = [];
    var orig = self.shareTab;
    self.shareTab = function (id) {
      return chrome.tabs.get(id).then(function (t) {
        self.__j3.push({ id: id, url: t && t.url });
        return orig(id);
      }, function (e) {
        self.__j3.push({ id: id, err: String(e && e.message || e) });
        return orig(id);
      });
    };
    self.__j3Wrapped = true;
    return 'wrapped';
  })()`);
  note('shareTabWrapper', wrap);

  // ---------- 9. make A the active tab, then fetch list-tabs in the panel ----------
  await cdp.send('Target.activateTarget', { targetId: A.targetId });
  await sleep(800);
  const tabs = JSON.parse(await msgFromPanel(sp, 'chrome-eye:list-tabs'));
  check('list-tabs ok', !!(tabs && tabs.ok && tabs.tabs), { n: tabs && tabs.tabs ? tabs.tabs.length : null });
  const active = tabs.tabs.find((t) => t.active) || null;
  const tabB = tabs.tabs.find((t) => t.url === 'http://127.0.0.1:9222/json') || null;
  const idA = active ? active.id : null;
  const idB = tabB ? tabB.id : null;
  check('active tab is A', !!(active && active.url === 'http://127.0.0.1:9222/json/version'), active);
  check('tab B listed', !!tabB, tabB);

  // ---------- 10. J3-1: button presence, position, dark styling ----------
  const btn = JSON.parse(await ev(sp, `(function () {
    var b = document.getElementById('ts-current-btn');
    if (!b) return JSON.stringify({ exists: false });
    var row = document.getElementById('stage-row');
    var cs = getComputedStyle(b);
    return JSON.stringify({
      exists: true,
      label: b.textContent,
      title: b.title,
      isFirstChild: row ? row.firstElementChild === b : null,
      color: cs.color,
      background: cs.backgroundColor,
      border: cs.borderTopColor,
      rowChildren: row ? Array.prototype.map.call(row.children, function (c) { return c.id; }) : []
    });
  })()`));
  check('J3-1 button exists', btn.exists === true, btn);
  check('J3-1 label "Add current tab"', btn.label === 'Add current tab', btn.label);
  check('J3-1 first child of #stage-row', btn.isFirstChild === true, btn.rowChildren);
  check('J3-1 dark green token (color rgb(86,211,100))', btn.color === 'rgb(86, 211, 100)', { color: btn.color, bg: btn.background, border: btn.border });

  // ---------- 11. J3-2: click → active tab staged + added ----------
  await ev(sp, `document.getElementById('ts-current-btn').click(); 'clicked'`);
  let status = '', flash = null, sawAdding = false, deadline = Date.now() + 30000, done = false;
  while (Date.now() < deadline) {
    await sleep(150);
    const s = JSON.parse(await ev(sp, `(function () {
      return JSON.stringify({
        status: document.getElementById('share-status').textContent,
        btn: document.getElementById('ts-current-btn').textContent,
        chips: document.getElementById('ts-chips').querySelectorAll('.ts-chip').length
      });
    })()`));
    status = s.status;
    if (s.btn === 'Adding…') sawAdding = true;
    if (s.btn && s.btn.indexOf('✓') === 0) flash = s.btn;
    if (flash || (s.btn && s.btn.indexOf('✕') === 0)) done = true;
    if (flash) break;
  }
  check('J3-2 share-status ok (fallback or injected)', /1 page added to session context|Saved 1 page \(no session open\)/.test(status), status);
  check('J3-2 inline confirmation flash', flash ? flash === '✓ Added current tab' : (sawAdding && /page/.test(status)), { flash: flash, sawAdding, status });

  const swAfter1 = JSON.parse(await ev(sw, 'JSON.stringify({ shared: self.__j3, staged: stagedTabs, gui: String(guiSessionId) })'));
  const chipsAfter1 = await ev(sp, `document.getElementById('ts-chips').querySelectorAll('.ts-chip').length`);
  check('J3-2 exactly one share, it is the ACTIVE tab (A)', swAfter1.shared.length === 1 && swAfter1.shared[0].id === idA && swAfter1.shared[0].url === 'http://127.0.0.1:9222/json/version', swAfter1.shared);
  check('J3-2 stagedTabs cleared + chips 0', swAfter1.staged.length === 0 && chipsAfter1 === 0, { staged: swAfter1.staged.length, chips: chipsAfter1 });
  note('share1path', status.indexOf('no session open') !== -1 ? 'fallback (Saved N page)' : (status.indexOf('added to session') !== -1 ? 'injected' : 'unknown'));

  // ---------- 12. screenshot with the dropdown open ----------
  await ev(sp, `document.getElementById('ts-btn').click(); 'dd-opened'`);
  let ddRows = 0;
  for (let i = 0; i < 20 && ddRows === 0; i++) {
    ddRows = await ev(sp, `document.querySelectorAll('#ts-dd-body .ts-row').length`).catch(() => 0);
    if (ddRows === 0) await sleep(300);
  }
  const curMarker = await ev(sp, `(function () {
    var row = document.querySelector('#ts-dd-body [data-tab-id="' + ${JSON.stringify(String(idA))} + '"]');
    return row ? (row.textContent || '').indexOf('· current tab') !== -1 : null;
  })()`);
  check('J3-3 dropdown lists rows + A marked "· current tab"', ddRows > 0 && curMarker === true, { ddRows, curMarker });
  const shotBtn = await ev(sp, `document.getElementById('ts-current-btn').textContent`);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sp);
  fs.writeFileSync('/tmp/task-j3-panel.png', Buffer.from(shot.data, 'base64'));
  check('screenshot written to /tmp/task-j3-panel.png', fs.existsSync('/tmp/task-j3-panel.png') && fs.statSync('/tmp/task-j3-panel.png').size > 10000, { bytes: fs.existsSync('/tmp/task-j3-panel.png') ? fs.statSync('/tmp/task-j3-panel.png').size : 0, btnAtShot: shotBtn });

  // ---------- 13. J3-3: existing "Add tabs" list still works (stage B, add) ----------
  const rowClick = await ev(sp, `(function () {
    var row = document.querySelector('#ts-dd-body [data-tab-id="' + ${JSON.stringify(String(idB))} + '"]');
    if (!row) return 'no-row';
    row.click();
    return 'clicked';
  })()`);
  check('J3-3 row B clickable', rowClick === 'clicked', rowClick);
  let chips2 = 0;
  for (let i = 0; i < 20 && chips2 === 0; i++) {
    chips2 = await ev(sp, `document.getElementById('ts-chips').querySelectorAll('.ts-chip').length`).catch(() => 0);
    if (chips2 === 0) await sleep(250);
  }
  check('J3-3 one chip staged for B', chips2 === 1, chips2);
  const addEnabled = await ev(sp, `document.getElementById('ts-add').disabled === false`);
  check('J3-3 #ts-add enabled with a chip', addEnabled === true, addEnabled);
  await ev(sp, `document.getElementById('ts-add').click(); 'add-clicked'`);

  const baseline = (JSON.parse(await ev(sw, 'JSON.stringify(self.__j3)'))).length;
  let status2 = '', deadline2 = Date.now() + 30000, done2 = false, shared2 = null;
  while (Date.now() < deadline2) {
    await sleep(250);
    shared2 = JSON.parse(await ev(sw, 'JSON.stringify(self.__j3)'));
    status2 = await ev(sp, `document.getElementById('share-status').textContent`).catch(() => '');
    if (shared2.length > baseline) done2 = true;
    if (done2) break;
  }
  const chipsAfter2 = await ev(sp, `document.getElementById('ts-chips').querySelectorAll('.ts-chip').length`);
  const stagedAfter2 = JSON.parse(await ev(sw, 'JSON.stringify(stagedTabs)'));
  const entry2 = shared2[shared2.length - 1];
  check('J3-3 list add shares B (not A)', !!entry2 && entry2.id === idB && entry2.url === 'http://127.0.0.1:9222/json', entry2);
  check('J3-3 staged cleared + chips 0 after add', stagedAfter2.length === 0 && chipsAfter2 === 0, { staged: stagedAfter2.length, chips: chipsAfter2, status2 });

  // ---------- 14. restore the :3081 GUI page (J1 environment state) ----------
  const guiRestored = (await cdp.send('Target.createTarget', { url: 'http://127.0.0.1:3081/' })).targetId;
  note('guiPageRestored', guiRestored);

  // ---------- verdict ----------
  fs.writeFileSync('/tmp/task-j3-evidence.json', JSON.stringify({ pass: E.pass, fails: E.fails, steps: E.steps, notes: E.notes }, null, 2));
  console.log('\n=== TASK J3 VERDICT: ' + (E.pass ? 'PASS' : 'FAIL') + ' ===');
  if (E.fails.length) console.log('failed: ' + E.fails.join(' | '));
  cdp.close();
  process.exit(E.pass ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e && e.message ? e.message : e);
  try { fs.writeFileSync('/tmp/task-j3-evidence.json', JSON.stringify({ pass: false, fatal: String(e).substring(0, 500), steps: E.steps, notes: E.notes }, null, 2)); } catch {}
  process.exit(2);
});
