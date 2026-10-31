#!/usr/bin/env node
// Task H gold test — fresh profile (CDP 9222):
//   H1: in-panel staging list at TOP of panel (not full-window overlay),
//       active tab pre-staged, check/uncheck rows, add-staged (gated).
//   H2: workspace dropdown lists real rows + opens a session in the iframe GUI.
// Also dumps the live in-iframe sidebar DOM for scraper root-cause analysis.
const BASE = 'http://127.0.0.1:9222';
const EXT_ID = 'mlolgaoijponghgfnlcljlohnhlpnhkd';
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
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).substring(0, 220) : ''));
}
function note(k, v) { E.notes.push({ k, v }); console.log('NOTE ' + k + ': ' + JSON.stringify(v).substring(0, 220)); }

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

  // ---------- 1. real http(s) tabs ----------
  const A = (await cdp.send('Target.createTarget', { url: 'http://127.0.0.1:9222/json/version' })).targetId;
  const B = (await cdp.send('Target.createTarget', { url: 'http://127.0.0.1:9222/json' })).targetId;
  await sleep(2500);
  await cdp.send('Target.activateTarget', { targetId: A });
  note('webTabs', { A, B });

  // ---------- 2. panel ----------
  const P = (await cdp.send('Target.createTarget', { url: `chrome-extension://${EXT_ID}/panel.html` })).targetId;
  const att = await cdp.send('Target.attachToTarget', { targetId: P, flatten: true });
  const sp = att.sessionId;
  await cdp.send('Runtime.enable', {}, sp);
  await cdp.send('Page.enable', {}, sp);
  for (let i = 0; i < 40 && (await ev(sp, 'document.readyState').catch(() => '')) !== 'complete'; i++) await sleep(500);
  note('panelTarget', P);

  // ---------- 3. iframe (:3081 GUI) ----------
  let iframe = null;
  for (let i = 0; i < 50; i++) {
    const ts = await listTargets();
    iframe = ts.find((x) => x.type === 'iframe' && x.url && x.url.indexOf('3081') !== -1) || null;
    if (iframe) break;
    await sleep(500);
  }
  if (!iframe) { check('iframe-3081 target exists', false, await listTargets().then((t) => t.map((x) => x.type + ':' + (x.url || '').substring(0, 50)))); }
  let si = null;
  if (iframe) {
    const a2 = await cdp.send('Target.attachToTarget', { targetId: iframe.targetId, flatten: true });
    si = a2.sessionId;
    await cdp.send('Runtime.enable', {}, si);
  }
  note('iframeTarget', iframe ? iframe.url : null);

  // ---------- 4. GUI boot wait ----------
  let booted = false;
  for (let i = 0; i < 90; i++) {
    const st = await ev(si, 'JSON.stringify({rs: document.readyState, len: (document.body ? document.body.innerText.length : 0)})').catch(() => null);
    if (st) { try { const o = JSON.parse(st); if (o.rs === 'complete' && o.len > 100) { booted = true; break; } } catch {} }
    await sleep(500);
  }
  check('GUI iframe booted', booted);

  // ---------- 5. H2 diagnostic dump (iframe sidebar DOM) ----------
  const diag = await ev(si, `(function(){
    var q = function (s) { return document.querySelectorAll(s); };
    var groups = q('[class*="_groupSection"]');
    var rows = q('[class*="_sessionRow"]');
    var projs = q('[class*="_projectRow"]');
    var items = q('[role="treeitem"]');
    var overflow = q('[class*="_sessionOverflowButton"]');
    var search = q('[class*="_searchResultRow"]');
    var sample = function (els, n) {
      var out = [];
      for (var i = 0; i < Math.min(els.length, n); i++) {
        var e = els[i];
        out.push({
          cls: (e.className || '').toString().substring(0, 140),
          text: (e.textContent || '').trim().substring(0, 70),
          visible: !!(e.offsetWidth || e.offsetHeight)
        });
      }
      return out;
    };
    var rowChildren = function (r, n) {
      var out = [];
      var walk = function (el) {
        for (var i = 0; i < el.children.length && out.length < n; i++) {
          var c = el.children[i];
          out.push({ tag: c.tagName, cls: (c.className || '').toString().substring(0, 100), text: (c.textContent || '').trim().substring(0, 40) });
          walk(c);
        }
      };
      walk(r);
      return out;
    };
    var cur = '';
    try { cur = localStorage.getItem('dsh.sessions.current') || ''; } catch (e) { cur = 'ERR:' + e.message; }
    var projAttrs = null;
    if (projs[0]) {
      var pa = projs[0];
      var attrs = {};
      for (var a = 0; a < pa.attributes.length; a++) attrs[pa.attributes[a].name] = pa.attributes[a].value;
      projAttrs = { cls: (pa.className || '').toString().substring(0, 120), attrs: attrs };
    }
    return JSON.stringify({
      readyState: document.readyState,
      title: document.title,
      contentType: document.contentType,
      bodyLen: document.body ? document.body.innerText.length : 0,
      groupCount: groups.length,
      sessionRowCount: rows.length,
      projRowCount: projs.length,
      treeitemCount: items.length,
      overflowCount: overflow.length,
      searchCount: search.length,
      groupSample: sample(groups, 3),
      projAttrs: projAttrs,
      rowSample: sample(rows, 4),
      firstRowChildren: rows[0] ? rowChildren(rows[0], 12) : [],
      lsCurrent: cur,
      navSkeleton: (function () {
        var navs = q('nav, aside');
        var out = [];
        for (var i = 0; i < Math.min(navs.length, 4); i++) {
          var n = navs[i];
          var cs = getComputedStyle(n);
          out.push({ tag: n.tagName, cls: (n.className || '').toString().substring(0, 80), display: cs.display, w: n.offsetWidth, h: n.offsetHeight, childCount: n.children.length });
        }
        return out;
      })()
    });
  })()`);
  const diagObj = JSON.parse(diag);
  note('sidebarDom', diagObj);

  // ---------- 6. H1: geometry — in-panel top row, NOT a full-window overlay ----------
  const geo = JSON.parse(await ev(sp, `(function(){
    var row = document.getElementById('stage-row');
    if (!row) return JSON.stringify({hasRow: false});
    var r = row.getBoundingClientRect();
    var cs = getComputedStyle(row);
    var iframeEl = document.getElementById('dsh-iframe');
    var order = iframeEl ? ((row.compareDocumentPosition(iframeEl) & 4) ? 'before-iframe' : 'after-iframe') : 'no-iframe';
    var fixedBig = [];
    var all = document.body.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      var c = getComputedStyle(e);
      if (c.position === 'fixed') {
        var b = e.getBoundingClientRect();
        if (b.width >= window.innerWidth * 0.9 && b.height >= window.innerHeight * 0.9 && c.display !== 'none' && c.visibility !== 'hidden') {
          fixedBig.push((e.id || '?') + ':' + (e.className || '').toString().substring(0, 40));
        }
      }
    }
    return JSON.stringify({
      hasRow: true, top: r.top, height: r.height, position: cs.position, order: order,
      fixedBig: fixedBig,
      tsBtn: document.getElementById('ts-btn') ? document.getElementById('ts-btn').textContent.trim() : null,
      chips: document.querySelectorAll('#ts-chips .ts-chip').length,
      tsAddDisabled: document.getElementById('ts-add') ? document.getElementById('ts-add').disabled : null,
      bridgeOverlayHidden: document.getElementById('bridge-overlay') ? document.getElementById('bridge-overlay').hidden : null
    });
  })()`));
  check('H1 #stage-row exists', geo.hasRow === true, geo);
  check('H1 stage-row at top (top<5)', geo.hasRow && geo.top < 5, geo.top);
  check('H1 stage-row height 30-42', geo.hasRow && geo.height >= 30 && geo.height <= 42, geo.height);
  check('H1 stage-row not fixed-position overlay', geo.hasRow && geo.position !== 'fixed', geo.position);
  check('H1 stage-row before #dsh-iframe in DOM', geo.hasRow && geo.order === 'before-iframe', geo.order);
  check('H1 no full-viewport fixed overlay', geo.hasRow && geo.fixedBig.length === 0, geo.fixedBig);

  // ---------- 7. H1: active tab pre-staged (re-fire panel-open with A active) ----------
  await cdp.send('Target.activateTarget', { targetId: A });
  await sleep(400);
  await ev(sp, `new Promise(function (res) { chrome.runtime.sendMessage({ type: 'chrome-eye:panel-open' }, function () { res('SENT'); }); })`);
  let chips = -1;
  for (let i = 0; i < 14; i++) {
    chips = await ev(sp, 'document.querySelectorAll("#ts-chips .ts-chip").length').catch(() => -1);
    if (chips >= 1) break;
    await sleep(500);
  }
  const btnTxt = await ev(sp, `document.getElementById('ts-btn').textContent.trim()`);
  const addDis = await ev(sp, `document.getElementById('ts-add').disabled`);
  check('H1 active tab staged → 1 chip', chips === 1, { chips, btnTxt });
  check('H1 button label "Add tabs (1)"', btnTxt === 'Add tabs (1)', btnTxt);
  check('H1 add-to-session enabled at ≥1', addDis === false, addDis);

  // ---------- 8. H1: dropdown list ----------
  await ev(sp, `document.getElementById('ts-btn').click(); 'clicked'`);
  let dd = null;
  for (let i = 0; i < 16; i++) {
    dd = JSON.parse(await ev(sp, `(function(){
      var dd = document.getElementById('ts-dropdown');
      var rows = document.querySelectorAll('#ts-dd-body .ts-row');
      var out = { hidden: dd.hasAttribute('hidden'), status: document.getElementById('ts-dd-status').textContent.trim(), rows: [] };
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        out.rows.push({
          id: r.getAttribute('data-tab-id'),
          url: r.querySelector('.ts-url') ? r.querySelector('.ts-url').textContent : '',
          title: r.querySelector('.ts-title') ? r.querySelector('.ts-title').textContent.trim() : '',
          on: r.className.indexOf('ts-row-on') !== -1,
          check: r.querySelector('.ts-check') ? r.querySelector('.ts-check').textContent : ''
        });
      }
      return JSON.stringify(out);
    })()`));
    if (!dd.hidden && dd.rows.length > 0) break;
    await sleep(500);
  }
  check('H1 dropdown opens', dd && !dd.hidden, dd);
  check('H1 dropdown lists both web tabs', dd && dd.rows.length === 2, dd && dd.rows.map((r) => r.url));
  const rowA = dd && dd.rows.find((r) => r.url.indexOf('json/version') !== -1);
  const rowB = dd && dd.rows.find((r) => r.url.indexOf('json') !== -1 && r.url.indexOf('version') === -1);
  check('H1 active tab row checked + "· current tab"', rowA && rowA.on && rowA.check === '✓' && rowA.title.indexOf('· current tab') !== -1, rowA);
  check('H1 inactive tab row unchecked', rowB && !rowB.on && rowB.check === '', rowB);
  check('H1 dropdown status line', dd && dd.status.indexOf('pages in this window') !== -1, dd && dd.status);

  // ---------- 9. H1: toggle rows ----------
  if (rowB) {
    await ev(sp, `(function(){ var rows = document.querySelectorAll('#ts-dd-body .ts-row'); for (var i = 0; i < rows.length; i++) { var u = rows[i].querySelector('.ts-url').textContent; if (u.indexOf('version') === -1) { rows[i].click(); return 'clicked-B'; } } return 'no-B'; })()`);
    await sleep(900);
    chips = await ev(sp, 'document.querySelectorAll("#ts-chips .ts-chip").length');
    check('H1 check row B → 2 chips', chips === 2, chips);
  }
  if (rowA) {
    await ev(sp, `(function(){ var rows = document.querySelectorAll('#ts-dd-body .ts-row'); for (var i = 0; i < rows.length; i++) { var u = rows[i].querySelector('.ts-url').textContent; if (u.indexOf('version') !== -1) { rows[i].click(); return 'clicked-A'; } } return 'no-A'; })()`);
    await sleep(900);
    chips = await ev(sp, 'document.querySelectorAll("#ts-chips .ts-chip").length');
    check('H1 uncheck row A → 1 chip (B remains)', chips === 1, chips);
    await ev(sp, `(function(){ var rows = document.querySelectorAll('#ts-dd-body .ts-row'); for (var i = 0; i < rows.length; i++) { var u = rows[i].querySelector('.ts-url').textContent; if (u.indexOf('version') !== -1) { rows[i].click(); return 'clicked-A2'; } } return 'no-A2'; })()`);
    await sleep(900);
    chips = await ev(sp, 'document.querySelectorAll("#ts-chips .ts-chip").length');
    check('H1 recheck row A → 2 chips', chips === 2, chips);
  }

  // ---------- 10. screenshot (H1 money shot: dropdown open, 2 chips) ----------
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sp, 15000);
  fs.writeFileSync('/tmp/task-h-panel.png', Buffer.from(shot.data, 'base64'));
  note('screenshot', '/tmp/task-h-panel.png');

  // ---------- 11. H1: add-staged (gated on no live session in the GUI) ----------
  const curNow = await ev(si, `try { localStorage.getItem('dsh.sessions.current') || '' } catch (e) { 'ERR' }`);
  if (!curNow) {
    await ev(sp, `document.getElementById('ts-add').click(); 'clicked'`);
    let shareTxt = '';
    for (let i = 0; i < 50; i++) {
      shareTxt = await ev(sp, `document.getElementById('share-status').textContent.trim()`).catch(() => '');
      if (shareTxt) break;
      await sleep(500);
    }
    check('H1 add-staged → "Saved 2 pages (no session open)"', /Saved 2 pages \(no session open\)/.test(shareTxt), shareTxt);
    chips = await ev(sp, 'document.querySelectorAll("#ts-chips .ts-chip").length').catch(() => -1);
    check('H1 chips cleared after add', chips === 0, chips);
    note('addStaged', { shareTxt, chips });
  } else {
    note('addStaged SKIPPED — dsh.sessions.current set in test iframe: ' + curNow.substring(0, 40), true);
  }

  // ---------- 12. H2: workspace dropdown ----------
  await ev(sp, `document.getElementById('ws-tree-btn').click(); 'clicked'`);
  let ws = null;
  for (let i = 0; i < 60; i++) {
    ws = JSON.parse(await ev(sp, `(function(){
      var dd = document.getElementById('ws-dropdown');
      if (dd.hasAttribute('hidden')) return JSON.stringify({ open: false });
      var rows = dd.querySelectorAll('.ce-ws-row');
      var out = { open: true, rowCount: rows.length, status: document.getElementById('ws-dd-status').textContent.trim(), body: (dd.querySelector('#ws-dd-body').textContent || '').trim().substring(0, 160) };
      out.rows = [];
      for (var i = 0; i < rows.length && i < 8; i++) out.rows.push(rows[i].textContent.trim().substring(0, 60));
      return JSON.stringify(out);
    })()`));
    if (ws.open && (ws.rowCount > 0 || ws.status === 'error' || ws.status.indexOf('loading') === -1)) break;
    await sleep(500);
  }
  note('wsDropdown', ws);
  const wsFail = ws && (ws.status === 'error' || /isn't visible|No DSH GUI tab|Could not read/i.test(ws.body + ' ' + ws.status));
  check('H2 dropdown open', ws && ws.open === true, ws);
  check('H2 real session rows present (not error/not-empty)', ws && !wsFail && ws.rowCount > 0, ws);
  if (ws && ws.rowCount > 0) {
    const firstRowTxt = ws.rows[0];
    await ev(sp, `(function(){ var r = document.querySelector('#ws-dropdown .ce-ws-row'); if (r) { r.click(); return 'clicked:' + r.textContent.trim().substring(0, 50); } return 'no-row'; })()`);
    let opened = '';
    for (let i = 0; i < 30; i++) {
      opened = await ev(sp, `document.getElementById('ws-dd-status').textContent.trim()`).catch(() => '');
      if (opened.indexOf('opened') === 0 || opened.indexOf('Not in the sidebar') !== -1 || opened.indexOf('Could not open') !== -1) break;
      await sleep(500);
    }
    check('H2 click session → "opened" status', opened.indexOf('opened') === 0, { firstRowTxt, opened });
    let curAfter = '';
    for (let i = 0; i < 30; i++) {
      curAfter = await ev(si, `try { localStorage.getItem('dsh.sessions.current') || '' } catch (e) { 'ERR' }`).catch(() => '');
      if (curAfter) break;
      await sleep(500);
    }
    check('H2 iframe GUI current session updated', curAfter.length > 0, curAfter.substring(0, 40));
  }

  // ---------- verdict ----------
  fs.writeFileSync('/tmp/task-h-evidence.json', JSON.stringify({ pass: E.pass, fails: E.fails, steps: E.steps, notes: E.notes }, null, 2));
  console.log('\n=== TASK H GOLD VERDICT: ' + (E.pass ? 'PASS' : 'FAIL') + ' ===');
  if (E.fails.length) console.log('failed: ' + E.fails.join(' | '));
  cdp.close();
  process.exit(E.pass ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e && e.message ? e.message : e);
  try { fs.writeFileSync('/tmp/task-h-evidence.json', JSON.stringify({ pass: false, fatal: String(e).substring(0, 500), steps: E.steps, notes: E.notes }, null, 2)); } catch {}
  process.exit(2);
});
