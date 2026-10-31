#!/usr/bin/env node
// Task J4 verification — headless Chrome on 9222, extension
// mlolgaoijponghgfnlcljlohnhlpnhkd. Proves the Gemini-style "Add tabs"
// rework:
//   J4-1  J3's standalone "Add current tab" button is GONE; the
//         #stage-row is [label, chips, Add to session, chevron]; the
//         dropdown head (#ts-dd-head) is gone too.
//   J4-2  Clicking the header row (label) toggles the flush dropdown open
//         (rows = favicon + one-line title, slim footer status); the
//         chevron mirrors state (aria-expanded) and its arrow ROTATES
//         (computed transform = 90° matrix when open, identity/none when
//         closed). Clicking the chevron itself also toggles.
//   J4-3  The active tab is SELECTED BY DEFAULT the moment the list is
//         shown: its row has the " · Current tab" suffix, the filled
//         green check circle (.ts-check-on) and the green border box
//         (.ts-row-on); the SW staged-tabs list contains it.
//   J4-4  Clicking another row TOGGLES selection (multi-select): on →
//         check + border + chip; off again → chip removed; the active
//         row stays selected throughout.
//   J4-5  "→ Add to session" shares EXACTLY the selected tabs (both of
//         them) through the existing SW add-staged engine, takes the
//         isolated FALLBACK path (no real DSH session touched):
//         share-status "Saved 2 pages (no session open) → bridge HTTP 200",
//         staged list + chips cleared.
//   J4-6  Re-opening the list after the add pre-selects the active tab
//         again (the Gemini default re-asserts).
//   Screenshot with the dropdown open + both rows selected →
//   /tmp/task-j4-panel.png; evidence → /tmp/task-j4-evidence.json.
//
// Session isolation (same pattern as J3): close the top-level :3081 GUI
// page (one reporter), clear dsh.sessions.current from the shared :3081-
// origin localStorage (the panel-iframe reporter), set SW guiSessionId =
// null; a test-only composePayload wrapper strips sessionId as a
// deterministic fallback guard (noted in evidence).
const BASE = 'http://127.0.0.1:9222';
const EXT_ID = 'mlolgaoijponghgfnlcljlohnhlpnhkd';
const PANEL_URL = `chrome-extension://${EXT_ID}/panel.html`;
const A_URL = 'http://127.0.0.1:9222/json/version';
const B_URL = 'http://127.0.0.1:9222/json';
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

// Parse a CSS matrix() into numbers; returns null for 'none'.
function parseMatrix(t) {
  if (!t || t === 'none') return null;
  const m = t.match(/matrix\(([^)]+)\)/);
  if (!m) return null;
  return m[1].split(',').map((x) => parseFloat(x.trim()));
}
// true when the matrix is a 90° rotation (m12≈1, m21≈-1)
function isRot90(t) {
  const m = parseMatrix(t);
  return !!m && Math.abs(m[1] - 1) < 0.01 && Math.abs(m[2] + 1) < 0.01;
}
// true when the transform is absent or the identity matrix
function isIdentity(t) {
  if (!t || t === 'none') return true;
  const m = parseMatrix(t);
  if (!m) return false;
  return Math.abs(m[0] - 1) < 0.01 && Math.abs(m[3] - 1) < 0.01 && Math.abs(m[1]) < 0.01 && Math.abs(m[2]) < 0.01 && Math.abs(m[4]) < 0.01 && Math.abs(m[5]) < 0.01;
}

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

  // ---------- 1. web tabs A + B (reuse J1/J3's, else create) ----------
  let ts = await listTargets();
  const findTab = (url) => ts.find((x) => x.type === 'page' && x.url === url);
  let A = findTab(A_URL);
  let B = findTab(B_URL);
  if (!A) A = { targetId: (await cdp.send('Target.createTarget', { url: A_URL })).targetId };
  if (!B) B = { targetId: (await cdp.send('Target.createTarget', { url: B_URL })).targetId };
  await sleep(2000);
  note('webTabs', { A: A.targetId, B: B.targetId });

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
  const iframe = ts.find((x) => x.type === 'iframe' && x.url && x.url.indexOf('127.0.0.1:3081') !== -1);
  let lsCleared = null;
  if (iframe) {
    const is = (await cdp.send('Target.attachToTarget', { targetId: iframe.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, is);
    lsCleared = await ev(is, `(() => { try { const k = Object.keys(localStorage).find(k => k.indexOf('dsh.sessions') === 0); if (k) { localStorage.removeItem(k); return 'removed ' + k; } return 'absent'; } catch (e) { return 'err ' + e.message; } })()`);
  } else {
    note('noIframeYet', 'will retry after a poll cycle');
  }
  note('lsClear', lsCleared);
  await sleep(2500); // outlive one 2 s reporter cycle
  lsCleared = null;
  ts = await listTargets();
  const iframe2 = ts.find((x) => x.type === 'iframe' && x.url && x.url.indexOf('127.0.0.1:3081') !== -1);
  if (iframe2) {
    const is2 = (await cdp.send('Target.attachToTarget', { targetId: iframe2.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, is2);
    lsCleared = await ev(is2, `(() => { try { const k = Object.keys(localStorage).find(k => k.indexOf('dsh.sessions') === 0); if (k) { localStorage.removeItem(k); return 'removed ' + k; } return 'absent'; } catch (e) { return 'err ' + e.message; } })()`);
  }
  note('lsClear2', lsCleared);

  // 6b. SW guiSessionId = null; verify it stays null after a poll cycle
  await ev(sw, 'guiSessionId = null; "ok"');
  await sleep(2600);
  const guiNow = JSON.parse(await ev(sw, 'JSON.stringify(guiSessionId)'));
  check('SW guiSessionId null after poll cycle', guiNow === null, guiNow);
  if (guiNow !== null) {
    // Deterministic fallback guard (noted in evidence): strip sessionId so
    // add-staged can only take the "no session open" bridge path.
    await ev(sw, `(() => { const orig = composePayload; composePayload = function (p) { const q = { }; for (const k in p) if (k !== 'sessionId') q[k] = p[k]; q.sessionId = ''; return orig(q); }; self.__j4guard = true; return 'wrapped'; })()`);
    note('composePayloadGuard', 'active — sessionId forced empty');
  }

  // ---------- 7. clear staged + chips; wrap shareTab to record calls ----------
  await ev(sw, 'stagedTabs = []; "ok"');
  await ev(sp, `(() => { const c = document.getElementById('ts-chips'); c.textContent = ''; const b = document.getElementById('ts-add'); if (b) b.disabled = true; return 'cleared'; })()`);
  // Idempotent wrap: if the SW survived a previous run, do NOT wrap again
  // (double-wrapping would double-push into self.__j4).
  await ev(sw, `(() => { if (!self.__j4orig) { self.__j4orig = shareTab; shareTab = function (id) { (self.__j4 = self.__j4 || []).push({ id: id, t: Date.now() }); return self.__j4orig(id); }; } self.__j4 = []; return 'wrapped'; })()`);

  // ---------- 8. pre-stage the ACTIVE tab (Gemini default, panel-open) ----------
  await cdp.send('Target.activateTarget', { targetId: A.targetId });
  await sleep(400);
  await msgFromPanel(sp, 'chrome-eye:panel-open');
  let stagedNow = null;
  for (let i = 0; i < 20; i++) {
    stagedNow = JSON.parse(await ev(sw, 'JSON.stringify(stagedTabs)'));
    if (stagedNow.length) break;
    await sleep(250);
  }
  check('setup: panel-open pre-stages the active tab A', !!stagedNow && stagedNow.length === 1 && stagedNow[0].url === A_URL, stagedNow);

  // chrome tab ids (what the dropdown's data-tab-id / stage-tab use)
  const idA = await ev(sp, `new Promise(function (r) { chrome.tabs.query({ url: ${JSON.stringify(A_URL)} }, function (t) { r(JSON.stringify(t && t[0] && t[0].id)); }); })`);
  const idB = await ev(sp, `new Promise(function (r) { chrome.tabs.query({ url: ${JSON.stringify(B_URL)} }, function (t) { r(JSON.stringify(t && t[0] && t[0].id)); }); })`);
  check('chrome tab ids resolved', !!idA && !!idB && idA !== idB, { idA, idB });

  // ---------- J4-1: J3 button removed; new row structure ----------
  const j3Gone = await ev(sp, `document.getElementById('ts-current-btn') === null`);
  check('J4-1 #ts-current-btn removed', j3Gone === true);
  const rowKids = await ev(sp, `(() => { const r = document.getElementById('stage-row'); return JSON.stringify(Array.from(r.children).map(c => c.id)); })()`);
  check('J4-1 #stage-row children = [ts-btn, ts-chips, ts-add, ts-chev]', rowKids === JSON.stringify(['ts-btn', 'ts-chips', 'ts-add', 'ts-chev']), rowKids);
  const ddHeadGone = await ev(sp, `document.getElementById('ts-dd-head') === null`);
  check('J4-1 #ts-dd-head removed', ddHeadGone === true);
  const chevronInfo = await ev(sp, `(() => { const c = document.getElementById('ts-chev'); const a = c && c.querySelector('.ts-chev-arrow'); const cs = c ? getComputedStyle(c) : null; return JSON.stringify({ present: !!c, arrowText: a ? a.textContent : null, aria: c ? c.getAttribute('aria-expanded') : null }); })()`);
  check('J4-1 chevron present, collapsed initially', JSON.parse(chevronInfo).present === true && JSON.parse(chevronInfo).aria === 'false', chevronInfo);
  const label = await ev(sp, `document.getElementById('ts-btn').textContent`);
  check('J4-1 label reads "Add tabs"', label === 'Add tabs', label);

  // ---------- J4-2: row click opens the flush dropdown; chevron rotates ----------
  await ev(sp, `document.getElementById('ts-btn').click(); "ok"`);
  await sleep(1500); // list-tabs round-trip
  // NB: in headless Chrome the compositor-driven transform transition is not
  // reflected into getComputedStyle until a frame commits (reads lag the
  // attribute change). Freeze the transition + force a style recalc so the
  // read reports the true target value of the CSS rule.
  const arrowT = (aria) => `(() => { const a = document.getElementById('ts-chev').querySelector('.ts-chev-arrow'); a.style.transition = 'none'; void a.offsetWidth; return new Promise(r => setTimeout(() => { const t = getComputedStyle(a).transform; a.style.transition = ''; r(JSON.stringify(t)); }, 120)); })()`;
  const openState = await ev(sp, `(async () => {
    const dd = document.getElementById('ts-dropdown');
    const rows = dd.querySelectorAll('.ts-row');
    const chev = document.getElementById('ts-chev');
    const arrow = chev.querySelector('.ts-chev-arrow');
    const arrowTransform = JSON.parse(await ${arrowT('true')});
    const cs = getComputedStyle(dd);
    const t = rows.length ? getComputedStyle(rows[0].querySelector('.ts-title')) : null;
    const rowInfo = Array.from(rows).map(r => ({
      id: r.getAttribute('data-tab-id'),
      on: r.classList.contains('ts-row-on'),
      title: r.querySelector('.ts-title') ? r.querySelector('.ts-title').textContent : null,
      hasFav: !!(r.querySelector('.ts-fav-img') || r.querySelector('.ts-dot')),
      lines: r.querySelectorAll('.ts-title').length
    }));
    return JSON.stringify({
      hidden: dd.hasAttribute('hidden'),
      rowCount: rows.length,
      ariaBtn: document.getElementById('ts-btn').getAttribute('aria-expanded'),
      ariaChev: chev.getAttribute('aria-expanded'),
      arrowTransform,
      ddLeft: cs.left, ddTop: cs.top, ddBg: cs.backgroundColor,
      ddRadiusTL: cs.borderTopLeftRadius, ddRadiusTR: cs.borderTopRightRadius,
      ddShadow: cs.boxShadow,
      titleOverflow: t ? t.textOverflow : null, titleWrap: t ? t.whiteSpace : null,
      statusText: document.getElementById('ts-dd-status').textContent,
      rows: rowInfo
    });
  })()`);
  const O = JSON.parse(openState);
  check('J4-2 row click opens dropdown (not hidden)', O.hidden === false && O.ariaBtn === 'true', { hidden: O.hidden, ariaBtn: O.ariaBtn });
  check('J4-2 chevron aria-expanded=true when open', O.ariaChev === 'true', O.ariaChev);
  check('J4-2 chevron arrow ROTATED (90° matrix) when open', isRot90(O.arrowTransform), O.arrowTransform);
  check('J4-2 both tab rows rendered', O.rowCount === 2, O.rows);
  check('J4-2 rows are single-line favicon + title (no url line, no second line)', O.rows.every(r => r.hasFav === true && r.lines === 1 && r.title && r.title.indexOf('http') === -1), O.rows);
  check('J4-2 dropdown flush with row (left 0, top 36, dark bg, no radius/shadow)', O.ddLeft === '0px' && O.ddTop === '36px' && O.ddBg === 'rgb(35, 35, 36)' && O.ddRadiusTL === '0px' && O.ddRadiusTR === '0px' && (O.ddShadow === 'none' || O.ddShadow === 'rgba(0, 0, 0, 0)'), { left: O.ddLeft, top: O.ddTop, bg: O.ddBg, radius: O.ddRadiusTL, shadow: O.ddShadow });
  check('J4-2 title truncation css (ellipsis + nowrap)', O.titleOverflow === 'ellipsis' && O.titleWrap === 'nowrap', { ov: O.titleOverflow, wrap: O.titleWrap });
  check('J4-2 slim footer status text', /2 pages in this window/.test(O.statusText), O.statusText);

  // chevron click closes it
  await ev(sp, `document.getElementById('ts-chev').click(); "ok"`);
  await sleep(400);
  const closedState = await ev(sp, `(async () => {
    const dd = document.getElementById('ts-dropdown');
    const chev = document.getElementById('ts-chev');
    const t = JSON.parse(await ${arrowT('false')});
    return JSON.stringify({ hidden: dd.hasAttribute('hidden'), aria: chev.getAttribute('aria-expanded'), t });
  })()`);
  const C = JSON.parse(closedState);
  check('J4-2 chevron click closes dropdown + arrow un-rotated', C.hidden === true && C.aria === 'false' && isIdentity(C.t), C);

  // ---------- J4-3: active tab pre-selected as soon as the list is shown ----------
  await ev(sp, `document.getElementById('ts-chev').click(); "ok"`);
  let rowAState = null;
  for (let i = 0; i < 24; i++) {
    rowAState = await ev(sp, `(() => {
      const r = document.querySelector('#ts-dd-body .ts-row[data-tab-id="' + ${JSON.stringify(idA)} + '"]');
      if (!r) return JSON.stringify({ found: false });
      const chk = r.querySelector('.ts-check');
      const cs = getComputedStyle(r);
      const chs = getComputedStyle(chk);
      return JSON.stringify({
        found: true,
        on: r.classList.contains('ts-row-on'),
        checkOn: chk.classList.contains('ts-check-on'),
        checkText: chk.textContent,
        checkBg: chs.backgroundColor,
        border: cs.borderColor,
        radius: cs.borderRadius,
        title: r.querySelector('.ts-title').textContent
      });
    })()`);
    const RA = JSON.parse(rowAState);
    if (RA.found && RA.on && RA.checkOn) break;
    await sleep(300);
  }
  const RA = JSON.parse(rowAState);
  check('J4-3 active tab row PRE-SELECTED (border + filled green check + ✓)', RA.found === true && RA.on === true && RA.checkOn === true && RA.checkText === '✓', RA);
  check('J4-3 " · Current tab" suffix on the active row', typeof RA.title === 'string' && RA.title.indexOf('· Current tab') !== -1, RA.title);
  check('J4-3 selected styling: green border + rounded box + filled circle', /rgb\(86, 211, 100\)/.test(RA.border) && RA.radius === '8px' && RA.checkBg === 'rgb(86, 211, 100)', { border: RA.border, radius: RA.radius, checkBg: RA.checkBg });
  const stagedA = JSON.parse(await ev(sw, 'JSON.stringify(stagedTabs)'));
  check('J4-3 active tab in SW staged list (default selection = staged)', stagedA.length === 1 && stagedA[0].url === A_URL, stagedA);

  // ---------- J4-4: clicking another row toggles selection (multi-select) ----------
  await ev(sp, `document.querySelector('#ts-dd-body .ts-row[data-tab-id="' + ${JSON.stringify(idB)} + '"]').click(); "ok"`);
  await sleep(600);
  let sel = await ev(sp, `(() => {
    const ra = document.querySelector('#ts-dd-body .ts-row[data-tab-id="' + ${JSON.stringify(idA)} + '"]');
    const rb = document.querySelector('#ts-dd-body .ts-row[data-tab-id="' + ${JSON.stringify(idB)} + '"]');
    return JSON.stringify({ aOn: ra.classList.contains('ts-row-on'), bOn: rb.classList.contains('ts-row-on'), chips: document.getElementById('ts-chips').querySelectorAll('.ts-chip').length });
  })()`);
  sel = JSON.parse(sel);
  check('J4-4 click row B → B selected (border+check) and A still selected; chips=2', sel.aOn === true && sel.bOn === true && sel.chips === 2, sel);

  await ev(sp, `document.querySelector('#ts-dd-body .ts-row[data-tab-id="' + ${JSON.stringify(idB)} + '"]').click(); "ok"`);
  await sleep(600);
  sel = JSON.parse(await ev(sp, `(() => {
    const ra = document.querySelector('#ts-dd-body .ts-row[data-tab-id="' + ${JSON.stringify(idA)} + '"]');
    const rb = document.querySelector('#ts-dd-body .ts-row[data-tab-id="' + ${JSON.stringify(idB)} + '"]');
    const chkrb = rb.querySelector('.ts-check');
    return JSON.stringify({ aOn: ra.classList.contains('ts-row-on'), bOn: rb.classList.contains('ts-row-on'), bCheckText: chkrb.textContent, chips: document.getElementById('ts-chips').querySelectorAll('.ts-chip').length });
  })()`));
  check('J4-4 click row B again → B un-selected (check emptied), A untouched; chips=1', sel.aOn === true && sel.bOn === false && sel.bCheckText === '' && sel.chips === 1, sel);

  await ev(sp, `document.querySelector('#ts-dd-body .ts-row[data-tab-id="' + ${JSON.stringify(idB)} + '"]').click(); "ok"`);
  await sleep(600);
  sel = JSON.parse(await ev(sp, `(() => {
    const ra = document.querySelector('#ts-dd-body .ts-row[data-tab-id="' + ${JSON.stringify(idA)} + '"]');
    const rb = document.querySelector('#ts-dd-body .ts-row[data-tab-id="' + ${JSON.stringify(idB)} + '"]');
    return JSON.stringify({ aOn: ra.classList.contains('ts-row-on'), bOn: rb.classList.contains('ts-row-on'), chips: document.getElementById('ts-chips').querySelectorAll('.ts-chip').length });
  })()`));
  check('J4-4 click row B again → B re-selected; chips=2', sel.aOn === true && sel.bOn === true && sel.chips === 2, sel);
  const stagedB = JSON.parse(await ev(sw, 'JSON.stringify(stagedTabs)'));
  check('J4-4 SW staged list = [A, B] (selection mirrors staging)', stagedB.length === 2 && stagedB[0].url === A_URL && stagedB[1].url === B_URL, stagedB);

  // ---------- screenshot: dropdown open, both rows selected ----------
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sp);
  fs.writeFileSync('/tmp/task-j4-panel.png', Buffer.from(shot.data, 'base64'));
  note('screenshot', '/tmp/task-j4-panel.png');

  // ---------- J4-5: Add to session shares EXACTLY the selected tabs ----------
  const baseline = JSON.parse(await ev(sw, 'JSON.stringify(self.__j4.length)'));
  await ev(sp, `document.getElementById('ts-add').click(); "ok"`);
  let shared = null, status = '';
  const deadline = Date.now() + 30000;
  let done = false;
  while (Date.now() < deadline) {
    await sleep(250);
    shared = JSON.parse(await ev(sw, 'JSON.stringify(self.__j4)'));
    status = await ev(sp, `document.getElementById('share-status').textContent`).catch(() => '');
    if (shared.length > baseline) done = true;
    if (done) break;
  }
  const stagedAfter = JSON.parse(await ev(sw, 'JSON.stringify(stagedTabs)'));
  const chipsAfter = await ev(sp, `document.getElementById('ts-chips').querySelectorAll('.ts-chip').length`);
  const fresh = shared.slice(baseline);
  check('J4-5 add-staged shares EXACTLY the 2 selected tabs, in staged order [A, B]', fresh.length === 2 && String(fresh[0].id) === String(idA) && String(fresh[1].id) === String(idB), fresh);
  check('J4-5 staged list + chips cleared after a full success', stagedAfter.length === 0 && chipsAfter === 0, { staged: stagedAfter.length, chips: chipsAfter });
  check('J4-5 fallback status: "Saved 2 pages (no session open) → bridge HTTP 200"', /Saved 2 pages \(no session open\)/.test(status) && /bridge HTTP 200/.test(status), status);
  const guiAfter = JSON.parse(await ev(sw, 'JSON.stringify(guiSessionId)'));
  check('J4-5 no real DSH session touched (guiSessionId still null)', guiAfter === null, guiAfter);

  // ---------- J4-6: re-open after add → active tab pre-selected again ----------
  await ev(sp, `document.getElementById('ts-btn').click(); "ok"`);
  let reState = null;
  for (let i = 0; i < 24; i++) {
    reState = await ev(sp, `(() => {
      const r = document.querySelector('#ts-dd-body .ts-row[data-tab-id="' + ${JSON.stringify(idA)} + '"]');
      if (!r) return JSON.stringify({ found: false });
      return JSON.stringify({ found: true, on: r.classList.contains('ts-row-on'), check: r.querySelector('.ts-check').textContent, title: r.querySelector('.ts-title').textContent });
    })()`);
    const RS = JSON.parse(reState);
    if (RS.found && RS.on) break;
    await sleep(300);
  }
  const RS = JSON.parse(reState);
  check('J4-6 after add + reopen, active tab A is selected by default again', RS.found === true && RS.on === true && RS.check === '✓' && RS.title.indexOf('· Current tab') !== -1, RS);
  const stagedRe = JSON.parse(await ev(sw, 'JSON.stringify(stagedTabs)'));
  check('J4-6 SW staged list re-asserts [A] only', stagedRe.length === 1 && stagedRe[0].url === A_URL, stagedRe);

  // ---------- restore the :3081 GUI page (J1 environment state) ----------
  const guiRestored = (await cdp.send('Target.createTarget', { url: 'http://127.0.0.1:3081/' })).targetId;
  note('guiPageRestored', guiRestored);

  // ---------- verdict ----------
  fs.writeFileSync('/tmp/task-j4-evidence.json', JSON.stringify({ pass: E.pass, fails: E.fails, steps: E.steps, notes: E.notes }, null, 2));
  console.log('\n=== TASK J4 VERDICT: ' + (E.pass ? 'PASS' : 'FAIL') + ' ===');
  if (E.fails.length) console.log('failed: ' + E.fails.join(' | '));
  cdp.close();
  process.exit(E.pass ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e && e.message ? e.message : e);
  try { fs.writeFileSync('/tmp/task-j4-evidence.json', JSON.stringify({ pass: false, fatal: String(e).substring(0, 500), steps: E.steps, notes: E.notes }, null, 2)); } catch {}
  process.exit(2);
});
