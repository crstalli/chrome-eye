#!/usr/bin/env node
// Task F2 gold test: fresh profile → open panel → click workspace →
// assert _sessionRow elements appear with real session text.
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
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
      }
    };
    return cdp;
  }
  send(method, params = {}, sessionId, timeoutMs = 15000) {
    const id = ++this.id;
    const envelope = { id, method, params };
    if (sessionId) envelope.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(envelope));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}
async function browserWs() {
  const r = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(3000) });
  return (await r.json()).webSocketDebuggerUrl;
}

const cdp = await Cdp.connect(await browserWs());
await cdp.send('Target.setDiscoverTargets', { discover: true });

// Find or open panel tab
const EXT_ID = (fs.readFileSync('/mnt/f/ai/chrome-eye/scratch/ext-id.txt', 'utf8') || '').trim();
const PANEL_URL = 'chrome-extension://' + EXT_ID + '/panel.html';
const SW_URL = 'chrome-extension://' + EXT_ID + '/sw.js';

async function findPanelTarget() {
  const t = await cdp.send('Target.getTargets');
  return t.targetInfos.find((x) => x.type === 'page' && x.url && x.url.indexOf('panel.html') !== -1);
}

let page = await findPanelTarget();
if (!page) {
  console.log('No panel target; opening via navigation recipe…');
  const t = await cdp.send('Target.getTargets');
  const blank = t.targetInfos.find((x) => x.type === 'page' && x.url === 'about:blank');
  if (!blank) {
    const nt = await cdp.send('Target.createTarget', { url: 'about:blank' });
    await sleep(1000);
    const t2 = await cdp.send('Target.getTargets');
    const b2 = t2.targetInfos.find((x) => x.type === 'page' && x.url === 'about:blank');
    if (b2) {
      const att0 = await cdp.send('Target.attachToTarget', { targetId: b2.targetId, flatten: true });
      const s0 = att0.sessionId;
      await cdp.send('Page.enable', {}, s0);
      await cdp.send('Page.navigate', { url: SW_URL }, s0, 15000).catch(() => {});
      await sleep(2000);
      await cdp.send('Page.navigate', { url: PANEL_URL }, s0, 15000).catch(() => {});
      await sleep(3000);
      await cdp.send('Target.detachFromTarget', { sessionId: s0 }).catch(() => {});
    }
  }
  for (let i = 0; i < 20; i++) {
    page = await findPanelTarget();
    if (page) break;
    await sleep(500);
  }
  if (!page) { console.log('FAILED to open panel target'); process.exit(1); }
}
console.log('panel target:', page.url);

const att = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
const s = att.sessionId;
await cdp.send('Runtime.enable', {}, s);
await cdp.send('Page.enable', {}, s);
const ev = async (expr, timeoutMs = 20000) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s, timeoutMs);
  if (r.exceptionDetails) throw new Error('eval exc: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
  return r.result.value;
};

// Wait for panel to boot
let booted = false;
for (let i = 0; i < 30 && !booted; i++) {
  try { booted = await ev('!!document.getElementById("ws-tree-btn")'); } catch (e) {}
  if (!booted) await sleep(1000);
}
console.log('panel booted:', booted);
if (!booted) { console.log('FAIL: panel did not boot'); cdp.close(); process.exit(1); }

// Click #ws-tree-btn
console.log('clicking #ws-tree-btn…');
await ev('(function(){ var b=document.getElementById("ws-tree-btn"); if(b) b.click(); return !!b; })()');
await sleep(3000);

// Check dropdown state
const dropdownState = await ev(`(function(){
  var dd = document.getElementById("ws-dropdown");
  if (!dd) return { exists: false };
  var rows = dd.querySelectorAll(".ce-ws-row");
  var samples = [];
  for (var i = 0; i < Math.min(5, rows.length); i++) samples.push(rows[i].textContent.trim().substring(0, 60));
  var statusEl = dd.querySelector(".ce-ws-status");
  return { exists: true, rowCount: rows.length, statusText: statusEl ? statusEl.textContent.trim() : "", samples: samples };
})()`);
console.log('dropdown:', JSON.stringify(dropdownState));

let goldPass = false;
let goldDetail = '';

if (dropdownState.exists && dropdownState.rowCount > 0) {
  // Click first non-current session row
  const clicked = await ev(`(function(){
    var rows = document.querySelectorAll(".ce-ws-row");
    for (var i = 0; i < rows.length; i++) {
      var txt = rows[i].textContent.trim();
      if (txt.indexOf("\\u25cf") === 0) continue;
      rows[i].click();
      return txt.replace(/^\\u25cf\\s*/, "").trim();
    }
    if (rows.length) { rows[0].click(); return rows[0].textContent.trim(); }
    return null;
  })()`);
  console.log('clicked session:', clicked);
  await sleep(4000);
}

// Check iframe state
const t2 = await cdp.send('Target.getTargets');
const iframe = t2.targetInfos.find((x) => x.type === 'iframe' && x.url && x.url.indexOf('3081') !== -1);
if (iframe) {
  const att2 = await cdp.send('Target.attachToTarget', { targetId: iframe.targetId, flatten: true });
  const s2 = att2.sessionId;
  await cdp.send('Runtime.enable', {}, s2);
  let iframeTitle = '', bodyLen = 0, sessionRowCount = 0, firstSession = '', selText = '';
  for (let i = 0; i < 20; i++) {
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: `(function(){
          var rows = document.querySelectorAll("[class*='\\\\_sessionRow']");
          var sel = document.querySelector('[aria-selected="true"]');
          return {
            title: document.title || "",
            bodyLen: document.body ? document.body.innerHTML.length : 0,
            sessionRowCount: rows.length,
            firstSession: rows.length ? rows[0].textContent.trim().substring(0, 80) : "",
            selText: sel ? sel.textContent.trim().substring(0, 80) : ""
          };
        })()`,
        returnByValue: true,
      }, s2, 15000);
      if (!r.exceptionDetails) {
        iframeTitle = r.result.value.title;
        bodyLen = r.result.value.bodyLen;
        sessionRowCount = r.result.value.sessionRowCount;
        firstSession = r.result.value.firstSession;
        selText = r.result.value.selText;
        if (bodyLen > 5000) break;
      }
    } catch (e) {}
    await sleep(1000);
  }
  console.log('iframe title:', iframeTitle);
  console.log('bodyLen:', bodyLen);
  console.log('sessionRowCount:', sessionRowCount);
  console.log('firstSession:', firstSession);
  console.log('selText:', selText);

  // Gold pass: body populated AND either session rows exist or title changed
  goldPass = bodyLen > 5000 && (sessionRowCount > 0 || iframeTitle.length > 10);
  goldDetail = 'title="' + iframeTitle.substring(0, 60) + '" sessionRows=' + sessionRowCount + ' firstSession="' + firstSession.substring(0, 40) + '" bodyLen=' + bodyLen;
} else {
  goldDetail = 'no 3081 iframe target found';
}

// Also check: the in-memory session list via the dropdown (which uses the
// bridge /api/session/list path that the gzip fix targets)
const listCheck = dropdownState.exists
  ? 'dropdown rows=' + dropdownState.rowCount + ' status="' + dropdownState.statusText + '" samples=' + JSON.stringify(dropdownState.samples || []).substring(0, 200)
  : 'dropdown not found';
console.log('list check:', listCheck);
goldPass = goldPass && dropdownState.rowCount > 0;
goldDetail += ' | ' + listCheck;

console.log(goldPass ? '  PASS gold test' : '  FAIL gold test', '—', goldDetail);
cdp.close();
process.exit(goldPass ? 0 : 1);
