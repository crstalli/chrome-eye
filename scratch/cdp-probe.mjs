#!/usr/bin/env node
// Chrome Eye verification probe (CDP, Node >= 22 native WebSocket, no npm).
// Usage: node cdp-probe.mjs [phaseA|phaseB]
// phaseA: panel tab + real :3080 tab → frame enumeration + content-script marker probes
// phaseB: panel-only → workspace-tree + overlay clicks, read UI state
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function listTargets() {
  const r = await fetch(`${BASE}/json/list`);
  return r.json();
}
async function newTab(url) {
  const r = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!r.ok) throw new Error('json/new -> ' + r.status);
  return r.json();
}
async function closeTarget(id) {
  await fetch(`${BASE}/json/close/${id}`);
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const cdp = new Cdp(ws);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error ' + wsUrl)); });
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString()); } catch { return; }
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject, timer } = cdp.pending.get(msg.id);
        clearTimeout(timer); cdp.pending.delete(msg.id);
        msg.error ? reject(new Error('CDP ' + msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of cdp.handlers.get(msg.method) ?? []) fn(msg.params);
      }
    };
    return cdp;
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
    return this;
  }
  send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

// content.js marker (isolated-world window props are invisible from the page
// world, but DOM is shared): the chip-strip root div carries
// z-index:2147483647 in its inline style and contains "→ add to session"
// buttons. Overlay div carries data-chrome-eye-overlay.
const PROBE = `(() => {
  const roots = document.querySelectorAll('div[style*="2147483647"]').length;
  const chipBtns = Array.from(document.querySelectorAll('button'))
    .filter(b => (b.textContent || '').includes('→ add to session')).length;
  const overlay = !!document.querySelector('[data-chrome-eye-overlay]');
  return JSON.stringify({ chipStripRoots: roots, addSessionButtons: chipBtns,
    overlay: overlay, title: document.title, url: location.href });
})()`;

function makeSession(cdp) {
  const consoleEvents = [];
  const contexts = [];
  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    consoleEvents.push(text);
  });
  cdp.on('Runtime.executionContextCreated', (p) => { contexts.push(p.context); });
  return {
    consoleEvents, contexts,
    async start() { await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); },
    async frameTree() { return cdp.send('Page.getFrameTree'); },
    async evalIn(contextId, expr) {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, contextId, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return 'EXCEPTION: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    }
  };
}

function findFrames(node, pred, out = []) {
  if (pred(node.frame)) out.push(node.frame);
  for (const c of node.childFrames ?? []) findFrames(c, pred, out);
  return out;
}

async function runPhaseA(panelT, guiT) {
  const panelCdp = await Cdp.connect(panelT.webSocketDebuggerUrl);
  const guiCdp = await Cdp.connect(guiT.webSocketDebuggerUrl);
  const panelS = makeSession(panelCdp);
  const guiS = makeSession(guiCdp);
  await panelS.start(); await guiS.start();
  await sleep(10000); // GUI load + >=2 chip poll cycles (2 s interval)

  console.log('\n--- CONSOLE (panel tab target) ---');
  for (const l of panelS.consoleEvents.slice(0, 40)) console.log('  ' + l);
  console.log('--- CONSOLE (gui tab target) ---');
  for (const l of guiS.consoleEvents.slice(0, 40)) console.log('  ' + l);

  const ft = await panelS.frameTree();
  console.log('\n--- PANEL PAGE FRAME TREE ---');
  const dump = (n, d = 0) => {
    console.log('  '.repeat(d) + `[${n.frame.id}] ${n.frame.url}`);
    for (const c of n.childFrames ?? []) dump(c, d + 1);
  };
  dump(ft.frameTree);

  const iframes = findFrames(ft.frameTree, (f) => (f.url || '').startsWith('http://127.0.0.1:3080'));
  console.log('\n:3080 frames inside panel page: ' + iframes.length + (iframes[0] ? ' (frame ' + iframes[0].id + ')' : ''));
  const guiMain = findFrames((await guiS.frameTree()).frameTree, () => true)[0];

  const guiMainCtx = guiS.contexts.find((c) => c.auxData?.frameId === guiMain.id);
  console.log('\n--- PROBE real GUI tab main context (positive control) ---');
  console.log(guiMainCtx ? await guiS.evalIn(guiMainCtx.id, PROBE) : 'no main context found');

  for (const f of iframes) {
    const c = panelS.contexts.find((x) => x.auxData?.frameId === f.id);
    console.log(`\n--- PROBE panel iframe ${f.id} (origin ${c?.origin ?? '?'}) ---`);
    console.log(c ? await panelS.evalIn(c.id, PROBE) : 'NO execution context found for iframe');
  }
  const panelTopCtx = panelS.contexts.find((c) => (c.origin || '').includes('chrome-extension'));
  if (panelTopCtx) {
    console.log('\n--- PROBE panel top frame (chrome-extension origin) ---');
    console.log(await panelS.evalIn(panelTopCtx.id, PROBE));
  }
  panelCdp.close(); guiCdp.close();
}

async function runPhaseB(extId) {
  const targets = await listTargets();
  const guiTab = targets.find((t) => t.type === 'page' && (t.url || '').startsWith('http://127.0.0.1:3080'));
  if (guiTab) { await closeTarget(guiTab.id); console.log('closed gui tab ' + guiTab.id); await sleep(2000); }
  const panelT = targets.find((t) => t.type === 'page' && t.url.includes(`chrome-extension://${extId}/panel.html`));
  if (!panelT) {
    // panel tab may have been in the list we just modified; re-list
    const t2 = (await listTargets()).find((t) => t.type === 'page' && t.url.includes(`chrome-extension://${extId}/panel.html`));
    if (!t2) throw new Error('panel tab not found');
    return runPhaseBInner(t2);
  }
  return runPhaseBInner(panelT);
}

async function runPhaseBInner(panelT) {
  const cdp = await Cdp.connect(panelT.webSocketDebuggerUrl);
  const s = makeSession(cdp);
  await s.start();
  await sleep(1000);

  console.log('\n--- open Workspaces dropdown (panel-only) ---');
  await cdp.send('Runtime.evaluate', { expression: `document.getElementById('ws-tree-btn').click()`, returnByValue: true });
  await sleep(3000);
  const dd = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({hidden: document.getElementById('ws-dropdown').hidden, status: document.getElementById('ws-dd-status').textContent, body: document.getElementById('ws-dd-body').textContent.slice(0,500)})`,
    returnByValue: true });
  console.log(dd.result.value);

  console.log('\n--- click overlay button (panel-only) ---');
  await cdp.send('Runtime.evaluate', { expression: `document.getElementById('ws-overlay-btn').click()`, returnByValue: true });
  await sleep(3000);
  const st = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({status: document.getElementById('share-status').textContent})`, returnByValue: true });
  console.log(st.result.value);

  const ft = await s.frameTree();
  const ifr = findFrames(ft.frameTree, (f) => (f.url || '').startsWith('http://127.0.0.1:3080'));
  if (ifr.length) {
    const c = s.contexts.find((x) => x.auxData?.frameId === ifr[0].id);
    console.log('\n--- panel iframe marker probe (panel-only) ---');
    console.log(c ? await s.evalIn(c.id, PROBE) : 'no context');
  }
  console.log('\n--- panel tab console (last 30) ---');
  for (const l of s.consoleEvents.slice(-30)) console.log('  ' + l);
  cdp.close();
}

async function main() {
  const phase = process.argv[2] || 'phaseA';
  const extId = fs.readFileSync('/mnt/f/ai/chrome-eye/scratch/ext-id.txt', 'utf8').trim();
  console.log('EXT_ID=' + extId);
  if (phase === 'phaseA') {
    // /json/new refuses chrome-extension: URLs → navigate the spare about:blank tab.
    const targets = await listTargets();
    const blank = targets.find((t) => t.type === 'page' && t.url === 'about:blank');
    if (!blank) throw new Error('no about:blank tab to reuse');
    const nav = await Cdp.connect(blank.webSocketDebuggerUrl);
    await nav.send('Page.enable');
    await nav.send('Page.navigate', { url: `chrome-extension://${extId}/panel.html` });
    await sleep(1500);
    const after = (await listTargets()).find((t) => t.id === blank.id);
    console.log('panel tab: ' + blank.id + ' (now ' + after.url + ')');
    const guiT = await newTab('http://127.0.0.1:3080');
    console.log('gui tab: ' + guiT.id);
    nav.close(); // release the WS before runPhaseA reconnects
    await runPhaseA({ id: blank.id, webSocketDebuggerUrl: blank.webSocketDebuggerUrl }, guiT);
  } else {
    await runPhaseB(extId);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
