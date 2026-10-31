#!/usr/bin/env node
// Gold test for Task F2: fresh profile, open panel, click workspace, assert sessions appear.
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

const ver = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(3000) });
const cdp = await Cdp.connect((await ver.json()).webSocketDebuggerUrl);
await cdp.send('Target.setDiscoverTargets', { discover: true });

// Navigate to the extension panel
const navTarget = await cdp.send('Target.createTarget', { url: `chrome-extension://${EXT_ID}/panel.html` });
const t = await cdp.send('Target.getTargets');
const panel = t.targetInfos.find((x) => x.targetId === navTarget.targetId);
const att = await cdp.send('Target.attachToTarget', { targetId: panel.targetId, flatten: true });
const s = att.sessionId;
await cdp.send('Runtime.enable', {}, s);
await cdp.send('Page.enable', {}, s);

// Wait for iframe to load
await sleep(8000);

// Find the iframe target
const t2 = await cdp.send('Target.getTargets');
const iframe = t2.targetInfos.find((x) => x.type === 'iframe' && x.url && x.url.indexOf('3081') !== -1);
if (!iframe) {
  console.log('FAIL: no 3081 iframe target found');
  process.exit(1);
}
console.log('iframe target:', iframe.url.substring(0, 60));
const att2 = await cdp.send('Target.attachToTarget', { targetId: iframe.targetId, flatten: true });
const s2 = att2.sessionId;
await cdp.send('Runtime.enable', {}, s2);

// Wait for the app to boot (session list should populate via mux)
await sleep(10000);

// Check the sidebar DOM for session rows
const check = await cdp.send('Runtime.evaluate', {
  expression: `
    (function() {
      var groups = document.querySelectorAll('[class*="_groupSection"]');
      var rows = document.querySelectorAll('[class*="_sessionRow"]');
      var projRows = document.querySelectorAll('[role="treeitem"]');
      var result = {
        groupCount: groups.length,
        sessionRowCount: rows.length,
        projRowCount: projRows.length,
        groupNames: [],
        firstSessions: []
      };
      for (var i = 0; i < groups.length; i++) {
        var nameEl = groups[i].querySelector('[class*="_projectRow"]');
        result.groupNames.push(nameEl ? nameEl.textContent.trim().substring(0, 40) : '?');
      }
      for (var j = 0; j < Math.min(rows.length, 5); j++) {
        result.firstSessions.push(rows[j].textContent.trim().substring(0, 60));
      }
      return JSON.stringify(result);
    })()
  `,
  returnByValue: true
}, s2, 10000);

const dom = JSON.parse(check.result.value);
console.log('DOM after boot:', JSON.stringify(dom, null, 2));

// If no session rows yet, try clicking a project row to expand
if (dom.sessionRowCount === 0 && dom.projRowCount > 0) {
  console.log('No session rows — clicking first project row to expand...');
  await cdp.send('Runtime.evaluate', {
    expression: `
      (function() {
        var proj = document.querySelector('[role="treeitem"]');
        if (proj) { proj.click(); return 'clicked'; }
        return 'no-proj-row';
      })()
    `,
    returnByValue: true
  }, s2, 10000);
  await sleep(5000);
  
  const check2 = await cdp.send('Runtime.evaluate', {
    expression: `
      (function() {
        var rows = document.querySelectorAll('[class*="_sessionRow"]');
        var result = { sessionRowCount: rows.length, firstSessions: [] };
        for (var j = 0; j < Math.min(rows.length, 5); j++) {
          result.firstSessions.push(rows[j].textContent.trim().substring(0, 60));
        }
        return JSON.stringify(result);
      })()
    `,
    returnByValue: true
  }, s2, 10000);
  const dom2 = JSON.parse(check2.result.value);
  console.log('DOM after expand click:', JSON.stringify(dom2, null, 2));
  dom.sessionRowCount = dom2.sessionRowCount;
  dom.firstSessions = dom2.firstSessions;
}

// Check the dropdown (panel-level)
const ddCheck = await cdp.send('Runtime.evaluate', {
  expression: `
    (function() {
      var dd = document.getElementById('ws-dropdown');
      if (!dd) return JSON.stringify({ visible: false });
      var rows = dd.querySelectorAll('.ce-ws-row');
      var status = dd.querySelector('.ce-ws-foot');
      return JSON.stringify({
        visible: dd.style.display !== 'none',
        rowCount: rows.length,
        statusText: status ? status.textContent.trim() : '',
        samples: Array.from(rows).slice(0, 5).map(function(r) { return r.textContent.trim().substring(0, 60); })
      });
    })()
  `,
  returnByValue: true
}, s, 10000);
const dd = JSON.parse(ddCheck.result.value);
console.log('Dropdown:', JSON.stringify(dd, null, 2));

// Verdict
const pass = dom.sessionRowCount > 0 && dom.firstSessions.length > 0;
console.log('\\n=== GOLD TEST VERDICT: ' + (pass ? 'PASS' : 'FAIL') + ' ===');
console.log('session rows: ' + dom.sessionRowCount);
console.log('first sessions: ' + JSON.stringify(dom.firstSessions));

// Save evidence
fs.writeFileSync('/tmp/f-gold-f2-evidence.json', JSON.stringify({
  dom: dom,
  dropdown: dd,
  pass: pass,
  timestamp: new Date().toISOString()
}, null, 2));

cdp.close();
process.exit(pass ? 0 : 1);
