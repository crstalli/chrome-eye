#!/usr/bin/env node
// ⚠️ SUPERSEDED (2026-09-21) — this file tests the OLD add-to-session
// semantics ("→ Add to session" button, pre-selected active tab, "Saved N
// pages"). The feature was redesigned to prompt-time attach (TASK J5b):
// staging is reference-only, add-staged is confirm-only, and context is
// captured FRESH at Enter time by composer-hook.js. The authoritative
// test is now e2e-attach-test.mjs (21/21 PASS, evidence e2e-evidence.png).
// Kept for reference; a full rewrite to the new panel-UI semantics is a
// J6 candidate. Do not rely on its pass/fail to judge the current build.
//
// (Original header:) Task J5 verification — headless Chrome on 9222, extension
// mlolgaoijponghgfnlcljlohnhlpnhkd. Proved the Gemini-clean "Add tabs"
// header rework:
//   J5-1  #stage-row contains ONLY the "Add tabs" label (+ " (N)" count)
//         and the chevron. The staged chips are GONE (no #ts-chips, no
//         .ts-chip anywhere). The "→ Add to session" button is OUT of the
//         header: it sits INSIDE #ts-dropdown, below the tab rows (DOM
//         order + geometry), full width, rounded, status-green.
//   J5-2  Chevron toggles the dropdown open/closed and its arrow ROTATES
//         (90° matrix open, identity closed); the label click toggles too.
//   J5-3  The active tab is PRE-SELECTED the moment the list is shown:
//         ✓ + filled green check + green border + " · Current tab" suffix;
//         header shows "Add tabs (1)"; SW staged list = [A].
//   J5-4  Row click TOGGLES selection on the row itself (✓ + green border)
//         and the header count follows: (1) → (2) on select, → (1) on
//         unselect; no chips ever appear.
//   J5-5  "→ Add to session" (below the list) shares EXACTLY the ✓-selected
//         tabs through the EXISTING SW add-staged engine (shareTab recorded
//         per tab), takes the isolated FALLBACK path (no real DSH session):
//         staged list cleared, all ✓ off, header back to plain "Add tabs"
//         (no count), the dropdown STAYS OPEN, the inline footer shows
//         "Saved 2 pages" (reverting to the list hint after ~3 s), and the
//         bottom bar mirrors "Saved 2 pages (no session open) → bridge
//         HTTP 200".
//   Screenshot (dropdown open, both rows selected, Add button below the
//   list) → /tmp/task-j5-panel.png; evidence → /tmp/task-j5-evidence.json.
//
// Session isolation (same pattern as J4): close the top-level :3081 GUI
// page (one reporter), clear dsh.sessions.current from the shared :3081-
// origin localStorage (the panel-iframe reporter), set SW guiSessionId =
// null; a test-only composePayload wrapper strips sessionId as a
// deterministic fallback guard (noted in evidence).
//
// Hard-constraint integrity (static): sw.js / manifest.json / content.js
// are NOT modified by J5 — content.js still carries the J1 bridge at
// lines 204–296 (T12.2 marker + the five verb names), and the three files'
// sha256 is recorded in the evidence notes for the record.
const BASE = 'http://127.0.0.1:9222';
const EXT_ID = 'mlolgaoijponghgfnlcljlohnhlpnhkd';
const EXT_DIR = '/mnt/f/ai/chrome-eye/extension';
const PANEL_URL = `chrome-extension://${EXT_ID}/panel.html`;
const A_URL = 'http://127.0.0.1:9222/json/version';
const B_URL = 'http://127.0.0.1:9222/json';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fs = await import('node:fs');
const crypto = await import('node:crypto');

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
function isRot90(t) {
  const m = parseMatrix(t);
  return !!m && Math.abs(m[1] - 1) < 0.01 && Math.abs(m[2] + 1) < 0.01;
}
function isIdentity(t) {
  if (!t || t === 'none') return true;
  const m = parseMatrix(t);
  if (!m) return false;
  return Math.abs(m[0] - 1) < 0.01 && Math.abs(m[3] - 1) < 0.01 && Math.abs(m[1]) < 0.01 && Math.abs(m[2]) < 0.01 && Math.abs(m[4]) < 0.01 && Math.abs(m[5]) < 0.01;
}
// Poll an eval until `pred(value)` is true (or timeout) → last value.
async function until(evFn, pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let v;
  for (;;) {
    v = await evFn();
    if (pred(v)) return v;
    if (Date.now() > deadline) return v;
    await sleep(250);
  }
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

  // ---------- 0. hard-constraint integrity (static, no reload needed) ----------
  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  const csLines = fs.readFileSync(EXT_DIR + '/content.js', 'utf8').split('\n').slice(203, 296).join('\n');
  check('J5-0 content.js J1 bridge intact at L204–296 (T12.2 + five verbs)',
    csLines.includes('T12.2 (Task J1)') && csLines.includes('list-tabs') && csLines.includes('stage-tab') && csLines.includes('unstage-tab') && csLines.includes('add-staged') && csLines.includes('panel-state'),
    { lines: 204 + '–' + 296 });
  note('unmodifiedFileSha256', {
    'sw.js': sha(EXT_DIR + '/sw.js'),
    'manifest.json': sha(EXT_DIR + '/manifest.json'),
    'content.js': sha(EXT_DIR + '/content.js'),
  });

  // ---------- 1. web tabs A + B (reuse J1/J3/J4's, else create) ----------
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
    await ev(sw, `(() => { const orig = composePayload; composePayload = function (p) { const q = { }; for (const k in p) if (k !== 'sessionId') q[k] = p[k]; q.sessionId = ''; return orig(q); }; self.__j5guard = true; return 'wrapped'; })()`);
    note('composePayloadGuard', 'active — sessionId forced empty');
  }

  // ---------- 7. clear staged; wrap shareTab to record per-tab calls ----------
  await ev(sw, 'stagedTabs = []; "ok"');
  // Idempotent wrap: if the SW survived a previous run, do NOT wrap again.
  await ev(sw, `(() => { if (!self.__j5orig) { self.__j5orig = shareTab; shareTab = function (id) { (self.__j5 = self.__j5 || []).push({ id: id, t: Date.now() }); return self.__j5orig(id); } } self.__j5 = []; return 'wrapped'; })()`);

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

  // NB: in headless Chrome the compositor-driven transform transition is not
  // reflected into getComputedStyle until a frame commits (reads lag the
  // attribute change). Freeze the transition + force a style recalc so the
  // read reports the true target value of the CSS rule.
  const arrowT = () => `(() => { const a = document.getElementById('ts-chev').querySelector('.ts-chev-arrow'); a.style.transition = 'none'; void a.offsetWidth; return new Promise(r => setTimeout(() => { const t = getComputedStyle(a).transform; a.style.transition = ''; r(JSON.stringify(t)); }, 120)); })()`;
  const btnText = () => `document.getElementById('ts-btn').textContent`;
  const rowState = (tid) => `(() => {
      const r = document.querySelector('#ts-dd-body .ts-row[data-tab-id="' + ${JSON.stringify(tid)} + '"]');
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
    })()`;

  // ---------- J5-1: header = ONLY label (+count) + chevron; chips gone;
  //          Add button OUT of the header, below the tab rows ----------
  const rowKids = await ev(sp, `(() => { const r = document.getElementById('stage-row'); return JSON.stringify(Array.from(r.children).map(c => c.id)); })()`);
  check('J5-1 #stage-row children = [ts-btn, ts-chev] ONLY (no chips, no Add button)', rowKids === JSON.stringify(['ts-btn', 'ts-chev']), rowKids);
  const chipsGone = await ev(sp, `document.getElementById('ts-chips') === null && document.querySelectorAll('.ts-chip').length === 0`);
  check('J5-1 staged chips fully removed (no #ts-chips, no .ts-chip)', chipsGone === true);
  const label0 = await ev(sp, btnText());
  check('J5-1 label reads "Add tabs" (no count at N=0 before pre-stage sync)', label0 === 'Add tabs', label0);
  const addPlacement = JSON.parse(await ev(sp, `(() => {
      const dd = document.getElementById('ts-dropdown');
      const ddBody = document.getElementById('ts-dd-body');
      const add = document.getElementById('ts-add');
      const row = document.getElementById('stage-row');
      const kids = Array.from(dd.children).map(c => c.id);
      const rAdd = add.getBoundingClientRect();
      const rBody = ddBody.getBoundingClientRect();
      const cs = getComputedStyle(add);
      return JSON.stringify({
        inHeader: row.contains(add),
        inDropdown: dd.contains(add),
        ddChildren: kids,
        belowList: rAdd.top >= rBody.bottom - 1,
        width: cs.width,
        radius: cs.borderRadius,
        marginTop: cs.marginTop,
        disabled: add.disabled,
        text: add.textContent
      });
    })()`));
  check('J5-1 #ts-add NOT in header, INSIDE #ts-dropdown below the tab rows',
    addPlacement.inHeader === false && addPlacement.inDropdown === true && JSON.stringify(addPlacement.ddChildren) === JSON.stringify(['ts-dd-body', 'ts-add', 'ts-dd-status']) && addPlacement.belowList === true,
    addPlacement);
  check('J5-1 #ts-add is full-width (100% - 12px), rounded, "→ Add to session"',
    addPlacement.text === '→ Add to session' && addPlacement.radius === '8px' && addPlacement.marginTop === '2px', addPlacement);

  // ---------- J5-2: chevron toggles open/close + arrow rotates ----------
  await ev(sp, `document.getElementById('ts-chev').click(); "ok"`);
  await sleep(1500); // list-tabs round-trip
  const openState = JSON.parse(await ev(sp, `(async () => {
    const dd = document.getElementById('ts-dropdown');
    const rows = dd.querySelectorAll('.ts-row');
    const chev = document.getElementById('ts-chev');
    const arrowTransform = JSON.parse(await ${arrowT()});
    return JSON.stringify({
      hidden: dd.hasAttribute('hidden'),
      rowCount: rows.length,
      ariaBtn: document.getElementById('ts-btn').getAttribute('aria-expanded'),
      ariaChev: chev.getAttribute('aria-expanded'),
      arrowTransform
    });
  })()`));
  check('J5-2 chevron click opens the dropdown (not hidden, aria-expanded)', openState.hidden === false && openState.ariaChev === 'true' && openState.ariaBtn === 'true', openState);
  check('J5-2 chevron arrow ROTATED (90° matrix) when open', isRot90(openState.arrowTransform), openState.arrowTransform);

  await ev(sp, `document.getElementById('ts-chev').click(); "ok"`);
  await sleep(300);
  const closedState = JSON.parse(await ev(sp, `(async () => {
    const dd = document.getElementById('ts-dropdown');
    const chev = document.getElementById('ts-chev');
    const t = JSON.parse(await ${arrowT()});
    return JSON.stringify({ hidden: dd.hasAttribute('hidden'), aria: chev.getAttribute('aria-expanded'), t });
  })()`));
  check('J5-2 chevron click closes the dropdown + arrow un-rotated', closedState.hidden === true && closedState.aria === 'false' && isIdentity(closedState.t), closedState);

  // the label click toggles too (row-level affordance, Gemini)
  await ev(sp, `document.getElementById('ts-btn').click(); "ok"`);
  await sleep(400);
  const labelToggles = JSON.parse(await ev(sp, `(() => { const dd = document.getElementById('ts-dropdown'); return JSON.stringify({ hidden: dd.hasAttribute('hidden'), aria: document.getElementById('ts-chev').getAttribute('aria-expanded') }); })()`));
  check('J5-2 label click also toggles (opens) the dropdown', labelToggles.hidden === false && labelToggles.aria === 'true', labelToggles);

  // ---------- J5-3: active tab pre-selected the moment the list is shown ----------
  let rowAState = null;
  for (let i = 0; i < 24; i++) {
    rowAState = await ev(sp, rowState(idA));
    const RA0 = JSON.parse(rowAState);
    if (RA0.found && RA0.on && RA0.checkOn) break;
    await sleep(300);
  }
  const RA = JSON.parse(rowAState);
  check('J5-3 active tab row PRE-SELECTED (✓ + filled green check + green border)', RA.found === true && RA.on === true && RA.checkOn === true && RA.checkText === '✓' && RA.checkBg === 'rgb(86, 211, 100)' && /rgb\(86, 211, 100\)/.test(RA.border) && RA.radius === '8px', RA);
  check('J5-3 active row carries the " · Current tab" suffix', RA.found === true && /· Current tab$/.test(RA.title), RA.title);
  const label1 = await until(() => ev(sp, btnText()), (t) => t === 'Add tabs (1)');
  check('J5-3 header count follows selection: "Add tabs (1)" with the pre-selected tab', label1 === 'Add tabs (1)', label1);
  const stagedA = JSON.parse(await ev(sw, 'JSON.stringify(stagedTabs)'));
  check('J5-3 active tab in SW staged list (default selection = staged)', stagedA.length === 1 && stagedA[0].url === A_URL, stagedA);
  const addEnabled = await ev(sp, `(() => { const a = document.getElementById('ts-add'); const cs = getComputedStyle(a); return JSON.stringify({ disabled: a.disabled, color: cs.color, bg: cs.backgroundColor }); })()`);
  check('J5-3 Add button enabled + status-green with a selection', JSON.parse(addEnabled).disabled === false && /rgb\(86, 211, 100\)/.test(JSON.parse(addEnabled).color), addEnabled);

  // ---------- J5-4: row click toggles ✓ + border; header (N) follows ----------
  await ev(sp, `document.querySelector('#ts-dd-body .ts-row[data-tab-id="' + ${JSON.stringify(idB)} + '"]').click(); "ok"`);
  const label2 = await until(() => ev(sp, btnText()), (t) => t === 'Add tabs (2)');
  const rowBOn = JSON.parse(await ev(sp, rowState(idB)));
  check('J5-4 click row B → B SELECTED (✓ + green border) and header "Add tabs (2)"', label2 === 'Add tabs (2)' && rowBOn.on === true && rowBOn.checkText === '✓' && /rgb\(86, 211, 100\)/.test(rowBOn.border), { label: label2, B: rowBOn });
  const noChips1 = await ev(sp, `document.querySelectorAll('.ts-chip').length`);
  check('J5-4 no staged chips anywhere (selection lives on the rows)', noChips1 === 0, noChips1);

  await ev(sp, `document.querySelector('#ts-dd-body .ts-row[data-tab-id="' + ${JSON.stringify(idB)} + '"]').click(); "ok"`);
  const label1b = await until(() => ev(sp, btnText()), (t) => t === 'Add tabs (1)');
  const rowBOff = JSON.parse(await ev(sp, rowState(idB)));
  const rowAStill = JSON.parse(await ev(sp, rowState(idA)));
  check('J5-4 click row B again → B UN-SELECTED (✓ + border off), header back to "Add tabs (1)", A untouched',
    label1b === 'Add tabs (1)' && rowBOff.on === false && rowBOff.checkText === '' && rowAStill.on === true, { label: label1b, B: rowBOff, Aon: rowAStill.on });

  // re-select B → both checked for the add step
  await ev(sp, `document.querySelector('#ts-dd-body .ts-row[data-tab-id="' + ${JSON.stringify(idB)} + '"]').click(); "ok"`);
  const label2b = await until(() => ev(sp, btnText()), (t) => t === 'Add tabs (2)');
  const stagedB = JSON.parse(await ev(sw, 'JSON.stringify(stagedTabs)'));
  check('J5-4 click row B again → re-selected; header "Add tabs (2)"; SW staged = [A, B]',
    label2b === 'Add tabs (2)' && stagedB.length === 2 && stagedB[0].url === A_URL && stagedB[1].url === B_URL, { label: label2b, staged: stagedB });

  // ---------- screenshot: dropdown open, both rows selected, Add below ----------
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sp);
  fs.writeFileSync('/tmp/task-j5-panel.png', Buffer.from(shot.data, 'base64'));
  note('screenshot', '/tmp/task-j5-panel.png');

  // ---------- J5-5: Add (below the list) → EXACTLY the ✓-selected tabs,
  //          fallback path, selection cleared, inline "Saved 2 pages" ----------
  const baseline = JSON.parse(await ev(sw, 'JSON.stringify(self.__j5.length)'));
  await ev(sp, `document.getElementById('ts-add').click(); "ok"`);
  let shared = null;
  const deadline = Date.now() + 30000;
  let done = false;
  while (Date.now() < deadline) {
    await sleep(250);
    shared = JSON.parse(await ev(sw, 'JSON.stringify(self.__j5)'));
    if (shared.length > baseline) { done = true; break; }
  }
  const fresh = shared.slice(baseline);
  check('J5-5 add-staged shares EXACTLY the ✓-selected tabs, in staged order [A, B]', done && fresh.length === 2 && String(fresh[0].id) === String(idA) && String(fresh[1].id) === String(idB), fresh);

  // wait for the resync: staged cleared + header count gone + all ✓ off
  const afterSync = await until(async () => JSON.parse(await ev(sp, `(() => {
      const ra = document.querySelector('#ts-dd-body .ts-row[data-tab-id="' + ${JSON.stringify(idA)} + '"]');
      const rb = document.querySelector('#ts-dd-body .ts-row[data-tab-id="' + ${JSON.stringify(idB)} + '"]');
      const dd = document.getElementById('ts-dropdown');
      const add = document.getElementById('ts-add');
      return JSON.stringify({
        label: document.getElementById('ts-btn').textContent,
        aOn: ra ? ra.classList.contains('ts-row-on') : null,
        bOn: rb ? rb.classList.contains('ts-row-on') : null,
        aCheck: ra ? ra.querySelector('.ts-check').textContent : null,
        bCheck: rb ? rb.querySelector('.ts-check').textContent : null,
        ddOpen: !dd.hasAttribute('hidden'),
        addDisabled: add.disabled,
        footer: document.getElementById('ts-dd-status').textContent,
        bottom: document.getElementById('share-status').textContent
      });
    })()`)), (s) => s.label === 'Add tabs' && s.aOn === false && s.bOn === false && /Saved 2 pages/.test(s.footer), 20000);
  check('J5-5 after add: staged cleared, header back to plain "Add tabs" (no count), all ✓ off',
    afterSync.label === 'Add tabs' && afterSync.aOn === false && afterSync.bOn === false && afterSync.aCheck === '' && afterSync.bCheck === '', afterSync);
  const stagedAfter = JSON.parse(await ev(sw, 'JSON.stringify(stagedTabs)'));
  check('J5-5 SW staged list empty after a full success', stagedAfter.length === 0, stagedAfter);
  check('J5-5 Add button disabled again (nothing staged)', afterSync.addDisabled === true, afterSync.addDisabled);
  check('J5-5 dropdown STAYS OPEN after the add (no auto-close)', afterSync.ddOpen === true, afterSync.ddOpen);
  check('J5-5 inline footer shows "Saved 2 pages"', afterSync.footer === 'Saved 2 pages', afterSync.footer);
  check('J5-5 bottom bar mirrors "Saved 2 pages (no session open) → bridge HTTP 200"',
    /Saved 2 pages \(no session open\)/.test(afterSync.bottom) && /bridge HTTP 200/.test(afterSync.bottom), afterSync.bottom);
  const guiAfter = JSON.parse(await ev(sw, 'JSON.stringify(guiSessionId)'));
  check('J5-5 no real DSH session touched (guiSessionId still null)', guiAfter === null, guiAfter);

  // the "Saved N pages" line reverts to the list hint after ~3 s (still open)
  const reverted = await until(() => ev(sp, `document.getElementById('ts-dd-status').textContent`), (t) => /pages in this window/.test(t), 6000);
  check('J5-5 "Saved 2 pages" is brief: reverts to the list hint while still open', reverted === '2 pages in this window — click to check', reverted);

  // ---------- restore the :3081 GUI page (J1 environment state) ----------
  const guiRestored = (await cdp.send('Target.createTarget', { url: 'http://127.0.0.1:3081/' })).targetId;
  note('guiPageRestored', guiRestored);

  // ---------- verdict ----------
  fs.writeFileSync('/tmp/task-j5-evidence.json', JSON.stringify({ pass: E.pass, fails: E.fails, steps: E.steps, notes: E.notes }, null, 2));
  console.log('\n=== TASK J5 VERDICT: ' + (E.pass ? 'PASS' : 'FAIL') + ' ===');
  if (E.fails.length) console.log('failed: ' + E.fails.join(' | '));
  cdp.close();
  process.exit(E.pass ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e && e.message ? e.message : e);
  try { fs.writeFileSync('/tmp/task-j5-evidence.json', JSON.stringify({ pass: false, fatal: String(e).substring(0, 500), steps: E.steps, notes: E.notes }, null, 2)); } catch {}
  process.exit(2);
});
