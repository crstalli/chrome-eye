#!/usr/bin/env node
// Task F gold test:
// 1. Panel page (extension tab) is already open at panel.html
// 2. Click #ws-tree-btn → dropdown should show REAL session rows
// 3. Click a session row → iframe should navigate to that session
// 4. Esc / ✕ close the overlay
// 5. Write evidence JSON
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
const evidence = { steps: [], failures: [] };
function step(name, ok, detail) {
  const entry = { step: name, ok: !!ok, detail: detail || '' };
  evidence.steps.push(entry);
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) evidence.failures.push(name);
}

// --- Find or open the panel tab ---
const EXT_ID = (fs.readFileSync('/mnt/f/ai/chrome-eye/scratch/ext-id.txt', 'utf8') || '').trim();
const PANEL_URL = 'chrome-extension://' + EXT_ID + '/panel.html';
const SW_URL = 'chrome-extension://' + EXT_ID + '/sw.js';

const cdp = await Cdp.connect(await browserWs());
await cdp.send('Target.setDiscoverTargets', { discover: true });

async function findPanelTarget() {
  const t = await cdp.send('Target.getTargets');
  return t.targetInfos.find((x) => x.type === 'page' && x.url && x.url.indexOf('panel.html') !== -1);
}

let page = await findPanelTarget();
if (!page) {
  // No panel tab — open one via the about:blank → sw.js → panel.html recipe
  console.log('No panel target found; opening via navigation recipe…');
  const t = await cdp.send('Target.getTargets');
  const blank = t.targetInfos.find((x) => x.type === 'page' && x.url === 'about:blank')
    || t.targetInfos.find((x) => x.type === 'page' && x.url.indexOf('chrome-extension://') === -1);
  if (!blank) {
    // create a new blank tab
    const nt = await cdp.send('Target.createTarget', { url: 'about:blank' });
    blank = { targetId: nt.targetId };
  }
  const att0 = await cdp.send('Target.attachToTarget', { targetId: blank.targetId, flatten: true });
  const s0 = att0.sessionId;
  await cdp.send('Page.enable', {}, s0);
  // Navigate to sw.js first to wake the service worker
  console.log('  navigating to sw.js…');
  await cdp.send('Page.navigate', { url: SW_URL }, s0, 15000).catch(() => {});
  await sleep(2000);
  // Navigate to panel.html
  console.log('  navigating to panel.html…');
  await cdp.send('Page.navigate', { url: PANEL_URL }, s0, 15000).catch(() => {});
  await sleep(3000);
  // detach the temporary session; the panel tab is now a normal page target
  await cdp.send('Target.detachFromTarget', { sessionId: s0 }).catch(() => {});
  // poll for the panel target to appear in the list
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
  if (r.exceptionDetails) throw new Error('eval exc: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};

// --- STEP 0: wait for the 3081 iframe target to appear in CDP ---
console.log('Step 0: wait for 3081 iframe target…');
let iframeReady = false;
for (let i = 0; i < 30 && !iframeReady; i++) {
  const t = await cdp.send('Target.getTargets');
  iframeReady = !!t.targetInfos.find((x) => x.type === 'iframe' && x.url && x.url.indexOf('3081') !== -1);
  if (!iframeReady) await sleep(1000);
}
step('3081 iframe target present', iframeReady, iframeReady ? 'iframe loaded' : 'timeout');

// --- STEP 1: click #ws-tree-btn → dropdown appears with real rows ---
console.log('Step 1: click workspace button…');
await ev(`(function(){ var b=document.getElementById('ws-tree-btn'); if(b) b.click(); return !!b; })()`);
await sleep(3000);
const dropdownState = await ev(`(function(){
  var dd = document.getElementById('ws-dd-body');
  if (!dd) return { exists: false };
  var rows = dd.querySelectorAll('.ce-ws-row');
  var status = document.getElementById('ws-dd-status');
  var texts = [];
  for (var i = 0; i < Math.min(rows.length, 8); i++) texts.push(rows[i].textContent.trim());
  return {
    exists: true,
    rowCount: rows.length,
    statusText: status ? status.textContent.trim() : '',
    sampleTexts: texts,
    ddVisible: dd.offsetParent !== null || dd.style.display !== 'none'
  };
})()`);
step('dropdown has real rows', dropdownState.rowCount > 0,
  'rows=' + dropdownState.rowCount + ' status="' + (dropdownState.statusText || '') + '" samples=' + JSON.stringify(dropdownState.sampleTexts || []).substring(0, 200));

// --- STEP 2: click a session row → iframe should show that session ---
let sessionClickOk = false;
let sessionClickDetail = '';
if (dropdownState.rowCount > 0) {
  console.log('Step 2: click a session row…');
  // Capture the iframe title BEFORE clicking so we can detect the change.
  const tBefore = await cdp.send('Target.getTargets');
  const iframeBefore = tBefore.targetInfos.find((x) => x.type === 'iframe' && x.url && x.url.indexOf('3081') !== -1);
  let titleBefore = '';
  if (iframeBefore) {
    try {
      const attB = await cdp.send('Target.attachToTarget', { targetId: iframeBefore.targetId, flatten: true });
      const sB = attB.sessionId;
      await cdp.send('Runtime.enable', {}, sB);
      const rB = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sB, 10000);
      if (!rB.exceptionDetails) titleBefore = rB.result.value || '';
    } catch (e) { /* frame may not be ready */ }
  }
  console.log('  iframe title before click:', titleBefore);

  const clickedRow = await ev(`(function(){
    var rows = document.querySelectorAll('.ce-ws-row');
    if (!rows.length) return null;
    // Pick the first row that is NOT the currently selected one (● prefix)
    var pick = null;
    for (var i = 0; i < rows.length; i++) {
      var txt = rows[i].textContent.trim();
      if (txt.indexOf('●') === 0) continue; // skip current session
      pick = rows[i];
      break;
    }
    if (!pick) pick = rows[0]; // fallback: first row
    var txt = pick.textContent.trim().replace(/^●\\s*/, '');
    pick.click();
    return txt;
  })()`);
  sessionClickDetail = 'clicked row: ' + clickedRow;
  console.log('  clicked:', clickedRow);
  // poll iframe for the session to appear — use document.title change as the
  // primary signal (DSH GUI sets the tab title to "<session> — DeepSeek
  // Harness"), plus body innerHTML length as a secondary check.
  await sleep(4000);
  const t2 = await cdp.send('Target.getTargets');
  const iframe = t2.targetInfos.find((x) => x.type === 'iframe' && x.url && x.url.indexOf('3081') !== -1);
  if (iframe) {
    const att2 = await cdp.send('Target.attachToTarget', { targetId: iframe.targetId, flatten: true });
    const s2 = att2.sessionId;
    await cdp.send('Runtime.enable', {}, s2);
    let iframeTitle = '';
    let selectedText = '';
    let bodyLen = 0;
    for (let i = 0; i < 25; i++) {
      try {
        const r = await cdp.send('Runtime.evaluate', {
          expression: `(function(){
            var sel = document.querySelector('[aria-selected="true"]');
            return {
              title: document.title || '',
              selectedText: sel ? sel.textContent.trim().substring(0, 100) : '',
              bodyLen: document.body ? document.body.innerHTML.length : 0
            };
          })()`,
          returnByValue: true,
        }, s2, 15000);
        if (!r.exceptionDetails) {
          iframeTitle = r.result.value.title || '';
          selectedText = r.result.value.selectedText || '';
          bodyLen = r.result.value.bodyLen || 0;
          // success: title contains the clicked session name AND body is populated
          if (iframeTitle.indexOf('DeepSeek Harness') !== -1 && bodyLen > 5000) break;
        }
      } catch (e) { /* frame may be navigating */ }
      await sleep(1000);
    }
    // Primary signal: the iframe title CHANGED from before the click AND the
    // body is populated. Secondary: the new title or selected row matches the
    // clicked text.
    const titleChanged = iframeTitle.length > 0 && iframeTitle !== titleBefore;
    const clickedClean = (clickedRow || '').substring(0, 40);
    const titleMatches = iframeTitle.indexOf(clickedClean) !== -1 || (selectedText.indexOf(clickedClean) !== -1);
    sessionClickOk = (titleChanged && bodyLen > 5000) || (titleMatches && bodyLen > 5000);
    sessionClickDetail = 'clicked="' + (clickedRow || '').substring(0, 60) + '" titleBefore="' + titleBefore.substring(0, 60) + '" titleAfter="' + iframeTitle.substring(0, 80) + '" selected="' + selectedText.substring(0, 60) + '" bodyLen=' + bodyLen;
    step('session click → iframe shows session', sessionClickOk, sessionClickDetail);
  } else {
    step('session click → iframe shows session', false, 'no 3081 iframe target found');
  }
} else {
  step('session click → iframe shows session', false, 'no rows to click');
}

// --- STEP 3: Esc closes the workspace dropdown ---
console.log('Step 3: Esc key…');
await ev(`(function(){
  var e = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true });
  document.dispatchEvent(e);
  return true;
})()`);
await sleep(1000);
const escClosed = await ev(`(function(){
  var dd = document.getElementById('ws-dd-body');
  return dd ? dd.style.display === 'none' || dd.offsetParent === null || !dd.querySelectorAll('.ce-ws-row').length : true;
})()`);
step('Esc closes dropdown', escClosed);

// --- STEP 4: overlay open + close (Task-D affordance) ---
console.log('Step 4: overlay open/close…');
await ev(`(function(){ var b=document.getElementById('ws-overlay-btn'); if(b) b.click(); return !!b; })()`);
await sleep(2000);
const overlayOpen = await ev(`(function(){
  var closeBtn = document.getElementById('ws-close-btn');
  var treeBtn = document.getElementById('ws-tree-btn');
  return {
    closeBtnVisible: closeBtn ? closeBtn.style.display !== 'none' && closeBtn.offsetParent !== null : false,
    treeBtnVisible: treeBtn ? treeBtn.style.display !== 'none' && treeBtn.offsetParent !== null : false
  };
})()`);
step('overlay opens (close button visible)', overlayOpen.closeBtnVisible,
  'closeBtn=' + overlayOpen.closeBtnVisible + ' treeBtn=' + overlayOpen.treeBtnVisible);
await ev(`(function(){ var b=document.getElementById('ws-close-btn'); if(b) b.click(); return !!b; })()`);
await sleep(1000);
const overlayClosed = await ev(`(function(){
  var closeBtn = document.getElementById('ws-close-btn');
  return closeBtn ? closeBtn.style.display === 'none' || closeBtn.offsetParent === null : true;
})()`);
step('overlay closes (✕)', overlayClosed);

// --- write evidence ---
evidence.exitCode = evidence.failures.length === 0 ? 0 : 1;
fs.writeFileSync('/mnt/f/ai/chrome-eye/scratch/f-gold-evidence.json', JSON.stringify(evidence, null, 2));
console.log('Evidence written to scratch/f-gold-evidence.json');
cdp.close();
process.exit(evidence.exitCode);
