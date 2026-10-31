#!/usr/bin/env node
// H2 root-cause probe: attach to the LIVE panel + :3081 iframe left open by
// task-h-gold.mjs. Dump per-group sidebar state (name, aria-expanded, row
// count, overflow), then click collapsed 'ai' group rows to expand, then
// re-click the panel's "New Session" row that failed before. If the
// re-click now succeeds, root cause = autoExpandCollapsedGroups() toggling
// expanded groups closed (stale scrape listed rows that vanished on re-render).
const BASE = 'http://127.0.0.1:9222';
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

const ver = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(3000) });
const cdp = await Cdp.connect((await ver.json()).webSocketDebuggerUrl);
await cdp.send('Target.setDiscoverTargets', { discover: true });
const ts = (await cdp.send('Target.getTargets')).targetInfos;
const panelT = ts.find((x) => x.type === 'page' && x.url && x.url.indexOf('panel.html') !== -1);
const iframeT = ts.find((x) => x.type === 'iframe' && x.url && x.url.indexOf('3081') !== -1);
if (!panelT || !iframeT) { console.log('FAIL: live targets missing', ts.map((x) => x.type + ':' + (x.url || '').substring(0, 50))); process.exit(1); }
const sp = (await cdp.send('Target.attachToTarget', { targetId: panelT.targetId, flatten: true })).sessionId;
const si = (await cdp.send('Target.attachToTarget', { targetId: iframeT.targetId, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, sp);
await cdp.send('Runtime.enable', {}, si);

const ev = async (sess, expr, timeoutMs = 25000) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sess, timeoutMs);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text;
    throw new Error('eval exception: ' + String(d).substring(0, 300));
  }
  return r.result ? r.result.value : undefined;
};

const DUMP = `(function(){
  function gname(g) {
    var p = g.querySelector('[class*="_projectRow"]');
    var n = p ? p.querySelector('[class*="_projectText"] [class*="_title"]') : null;
    return n ? (n.textContent || '').trim() : '';
  }
  function ttitle(r) {
    var t = r.querySelector('[class*="_title"]');
    return t ? (t.textContent || '').trim() : '';
  }
  var groups = document.querySelectorAll('[class*="_groupSection"]');
  var out = { groupCount: groups.length, sessionRowCount: document.querySelectorAll('[class*="_sessionRow"]').length, treeitemCount: document.querySelectorAll('[role="treeitem"]').length, groups: [] };
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    var pr = g.querySelector('[role="treeitem"]');
    var rows = g.querySelectorAll('[class*="_sessionRow"]');
    var titles = [];
    for (var j = 0; j < Math.min(rows.length, 3); j++) titles.push(ttitle(rows[j]));
    out.groups.push({
      name: JSON.stringify(gname(g)),
      ariaExpanded: pr ? pr.getAttribute('aria-expanded') : null,
      rowCount: rows.length,
      hasOverflow: !!g.querySelector('[class*="_sessionOverflowButton"]'),
      firstTitles: titles
    });
  }
  var cur = '';
  try { cur = localStorage.getItem('dsh.sessions.current') || ''; } catch (e) {}
  out.lsCurrent = cur.substring(0, 60);
  return JSON.stringify(out);
})()`;

console.log('--- dump1 (post-failed-click state) ---');
const d1 = JSON.parse(await ev(si, DUMP));
console.log(JSON.stringify(d1, null, 2));

// Expand any collapsed 'ai' groups (rows missing but group present)
console.log('--- expanding collapsed ai groups ---');
await ev(si, `(function(){
  function gname(g) {
    var p = g.querySelector('[class*="_projectRow"]');
    var n = p ? p.querySelector('[class*="_projectText"] [class*="_title"]') : null;
    return n ? (n.textContent || '').trim() : '';
  }
  var groups = document.querySelectorAll('[class*="_groupSection"]');
  var clicked = [];
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    var rows = g.querySelectorAll('[class*="_sessionRow"]');
    if (rows.length > 0) continue;
    var pr = g.querySelector('[role="treeitem"]');
    if (pr && gname(g) === 'ai') { pr.click(); clicked.push(gname(g)); }
  }
  return JSON.stringify(clicked);
})()`);
await sleep(1200);
console.log('--- dump2 (after expand clicks) ---');
const d2 = JSON.parse(await ev(si, DUMP));
console.log(JSON.stringify(d2, null, 2));

// Re-click the panel's first workspace row (the one that failed)
const preCur = d2.lsCurrent;
const rowTxt = await ev(sp, `(function(){ var r = document.querySelector('#ws-dropdown .ce-ws-row'); return r ? JSON.stringify(r.textContent.trim().substring(0, 50)) : 'none'; })()`);
console.log('re-clicking panel row:', rowTxt);
await ev(sp, `(function(){ var r = document.querySelector('#ws-dropdown .ce-ws-row'); if (r) r.click(); return 'clicked'; })()`);
let status = '';
for (let i = 0; i < 30; i++) {
  status = await ev(sp, `document.getElementById('ws-dd-status').textContent.trim()`).catch(() => '');
  if (status.indexOf('opened') === 0 || status.indexOf('Not in the sidebar') !== -1 || status.indexOf('Could not open') !== -1) break;
  await sleep(500);
}
console.log('status after re-click:', JSON.stringify(status));
let curAfter = '';
for (let i = 0; i < 30; i++) {
  curAfter = await ev(si, `try { (localStorage.getItem('dsh.sessions.current') || '').substring(0, 60) } catch (e) { 'ERR' }`).catch(() => '');
  if (curAfter && curAfter !== preCur) break;
  await sleep(500);
}
console.log('ls current before:', JSON.stringify(preCur));
console.log('ls current after :', JSON.stringify(curAfter));
console.log('--- dump3 (final sidebar state) ---');
const d3 = JSON.parse(await ev(si, DUMP));
console.log(JSON.stringify(d3, null, 2));

fs.writeFileSync('/tmp/task-h-h2probe.json', JSON.stringify({ d1, d2, d3, rowTxt, status, preCur, curAfter }, null, 2));
cdp.close();
