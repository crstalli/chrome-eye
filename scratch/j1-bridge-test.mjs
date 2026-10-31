#!/usr/bin/env node
// Task J1 bridge test — fresh profile (CDP 9222):
//   1. top-level :3081 GUI page (content.js injected via <all_urls>):
//        post chrome-eye:gui:list-tabs → capture :result, assert tab list
//        stage-tab / unstage-tab / panel-state round trips
//        unknown verb → ignored (no result)
//   2. panel's :3081 IFRAME: post from the frame → NO result (top-frame guard)
//   3. non-gui chrome-eye: message type → untouched by the bridge
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
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' — ' + JSON.stringify(detail).substring(0, 260) : ''));
}
function note(k, v) { E.notes.push({ k, v }); console.log('NOTE ' + k + ': ' + JSON.stringify(v).substring(0, 260)); }

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
  const attach = async (targetId) => {
    const f = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, f.sessionId);
    return f.sessionId;
  };
  const waitForReady = async (si) => {
    for (let i = 0; i < 50; i++) {
      const s = await ev(si, 'document.readyState').catch(() => 'error');
      if (s === 'complete') return true;
      await sleep(300);
    }
    return false;
  };

  // ---------- 1. real http(s) tabs (so list-tabs has content) ----------
  const A = (await cdp.send('Target.createTarget', { url: 'http://127.0.0.1:9222/json/version' })).targetId;
  const B = (await cdp.send('Target.createTarget', { url: 'http://127.0.0.1:9222/json' })).targetId;
  await sleep(2000);
  await cdp.send('Target.activateTarget', { targetId: A });

  // ---------- 2. panel (wakes the SW; its :3081 iframe hosts the guard test) ----------
  const P = (await cdp.send('Target.createTarget', { url: `chrome-extension://${EXT_ID}/panel.html` })).targetId;
  const ps = await attach(P);
  check('panel ready', await waitForReady(ps));

  // ---------- 3. top-level :3081 GUI page (the J2 plugin's home) ----------
  const G = (await cdp.send('Target.createTarget', { url: 'http://127.0.0.1:3081/' })).targetId;
  const gs = await attach(G);
  check('top :3081 GUI page ready', await waitForReady(gs));
  await sleep(1500); // content-script settle

  // ---------- 4. install result capture in the top window ----------
  await ev(gs, `(function () {
    window.__j1 = [];
    window.addEventListener('message', function (e) {
      if (e.data && typeof e.data.type === 'string' && e.data.type.indexOf('chrome-eye:gui:') === 0) window.__j1.push(e.data);
    });
    return 'installed';
  })()`);

  const post = (reqId, type, payload) =>
    ev(gs, `window.postMessage({type:${JSON.stringify(type)}, reqId:${reqId}, payload:${JSON.stringify(payload || {})}}, '*'); 'posted'`);
  const find = (reqId) =>
    ev(gs, `JSON.stringify((window.__j1 || []).filter(function (m) { return m.reqId === ${reqId} && m.type.indexOf(':result') !== -1; }))`);
  const waitResult = async (reqId, ms = 8000) => {
    const t0 = Date.now();
    for (;;) {
      const r = await find(reqId).catch(() => '[]');
      const arr = JSON.parse(r);
      if (arr.length) return arr[0];
      if (Date.now() - t0 > ms) return null;
      await sleep(300);
    }
  };

  // ---------- 5. list-tabs round trip ----------
  await post(1, 'chrome-eye:gui:list-tabs', {});
  const r1 = await waitResult(1);
  check('gui:list-tabs result arrives', !!r1, r1 && { type: r1.type });
  check('list-tabs carries tab list', r1 && r1.data && r1.data.ok === true && Array.isArray(r1.data.tabs) && r1.data.tabs.length >= 3,
    r1 && { n: r1.data && r1.data.tabs && r1.data.tabs.length, first: r1 && r1.data && r1.data.tabs && r1.data.tabs[0] && r1.data.tabs[0].title });
  note('tabs', r1 && r1.data && r1.data.tabs && r1.data.tabs.map((t) => ({ id: t.id, url: t.url.substring(0, 50), active: t.active })));

  // ---------- 6. stage-tab / unstage-tab / panel-state ----------
  const tabId = r1 && r1.data && r1.data.tabs && r1.data.tabs.find((t) => t.url.indexOf('json/version') !== -1 || t.url.indexOf('3081') !== -1);
  if (tabId) {
    await post(2, 'chrome-eye:gui:stage-tab', { tabId: tabId.id });
    const r2 = await waitResult(2);
    check('gui:stage-tab ok', r2 && r2.data && r2.data.ok === true && Array.isArray(r2.data.staged) && r2.data.staged.some((s) => s.id === tabId.id),
      r2 && { staged: r2.data && r2.data.staged && r2.data.staged.map((s) => s.id) });
    await post(3, 'chrome-eye:gui:unstage-tab', { tabId: tabId.id });
    const r3 = await waitResult(3);
    check('gui:unstage-tab ok', r3 && r3.data && r3.data.ok === true && r3.data.staged && r3.data.staged.every((s) => s.id !== tabId.id),
      r3 && { staged: r3.data && r3.data.staged });
  } else {
    check('stage-tab target found', false, 'no suitable tab in list');
  }
  await post(4, 'chrome-eye:gui:panel-state', {});
  const r4 = await waitResult(4);
  check('gui:panel-state ok', r4 && r4.data && r4.data.ok === true && r4.data.panelOpen === true,
    r4 && { panelOpen: r4.data && r4.data.panelOpen, staged: (r4.data && r4.data.staged || []).length });

  // ---------- 7. unknown verb → ignored (no reply, no loop) ----------
  await post(5, 'chrome-eye:gui:bogus-verb', {});
  await sleep(1200);
  const r5 = await find(5);
  check('unknown gui verb ignored', JSON.parse(r5).length === 0, r5);
  // Expected capture in the top window: 5 original gui posts (reqIds 1-5) +
  // 4 results (reqIds 1-4). Any double ':result' suffix would mean a loop.
  const counts = await ev(gs, `(function () {
    var a = window.__j1 || [];
    return JSON.stringify({
      total: a.length,
      results: a.filter(function (m) { return m.type.indexOf(':result') !== -1; }).length,
      doubled: a.filter(function (m) { return m.type.indexOf(':result:result') !== -1; }).length
    });
  })()`).catch(() => '{"total":-1}');
  const c = JSON.parse(counts);
  check('no reply loop (5 originals + 4 results, no :result:result)', c.total === 9 && c.results === 4 && c.doubled === 0, counts);

  // ---------- 8. internal chrome-eye: namespace untouched by bridge ----------
  await post(6, 'chrome-eye:internal-probe', {});
  await sleep(1200);
  const r6 = await find(6);
  check('non-gui chrome-eye: type ignored', JSON.parse(r6).length === 0, r6);

  // ---------- 9. top-frame guard: post from inside the panel's :3081 IFRAME ----------
  let frameTarget = null;
  for (let i = 0; i < 30 && !frameTarget; i++) {
    for (const t of await listTargets()) {
      if (t.type === 'iframe' && t.url && t.url.indexOf('3081') !== -1) frameTarget = t;
    }
    if (!frameTarget) await sleep(300);
  }
  if (frameTarget) {
    const fi = await attach(frameTarget.targetId);
    await sleep(800);
    await ev(fi, `(function () {
      window.__j1frame = [];
      window.addEventListener('message', function (e) {
        if (e.data && typeof e.data.type === 'string' && e.data.type.indexOf('chrome-eye:gui:') === 0) window.__j1frame.push(e.data);
      });
      return 'installed';
    })()`);
    await ev(fi, `window.postMessage({type:'chrome-eye:gui:list-tabs', reqId:9, payload:{}}, '*'); 'posted'`);
    await sleep(1500);
    // The iframe's own page listener captures its own original post (that's
    // fine); what matters is that the iframe content.js (window!==window.top)
    // did NOT forward it → no ':result' may appear in the iframe.
    const fr = await ev(fi, `(function () {
      var a = window.__j1frame || [];
      return JSON.stringify({
        total: a.length,
        results: a.filter(function (m) { return m.type.indexOf(':result') !== -1; }).length
      });
    })()`).catch(() => '{"total":-1,"results":-1}');
    const fc = JSON.parse(fr);
    check('iframe post NOT bridged (top-frame guard, no :result)', fc.results === 0, fr);
    const topHas9 = await find(9);
    check('top window did not receive iframe post', JSON.parse(topHas9).length === 0, topHas9);
  } else {
    note('iframeTarget', 'no :3081 iframe target found — guard check skipped');
  }

  fs.writeFileSync('/tmp/task-j1-evidence.json', JSON.stringify({ pass: E.pass, fails: E.fails, steps: E.steps, notes: E.notes }, null, 2));
  console.log('\n=== TASK J1 BRIDGE VERDICT: ' + (E.pass ? 'PASS' : 'FAIL') + ' ===');
  if (E.fails.length) console.log('failed: ' + E.fails.join(' | '));
  cdp.close();
  process.exit(E.pass ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e && e.message ? e.message : e);
  try { fs.writeFileSync('/tmp/task-j1-evidence.json', JSON.stringify({ pass: false, fatal: String(e).substring(0, 500), steps: E.steps, notes: E.notes }, null, 2)); } catch {}
  process.exit(2);
});
