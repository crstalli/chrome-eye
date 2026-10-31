#!/usr/bin/env node
// Phase A2: navigate a spare tab to the REAL extension panel URL (ID from the
// live SW target), keep/reuse the :3080 GUI tab, then run frame + marker probes.
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listTargets = async () => (await fetch(`${BASE}/json/list`)).json();
const newTab = async (url) => {
  const r = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!r.ok) throw new Error('json/new ' + r.status);
  return r.json();
};
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const cdp = new Cdp(ws);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(String(m.data)); } catch { return; }
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
  on(m, fn) { if (!this.handlers.has(m)) this.handlers.set(m, []); this.handlers.get(m).push(fn); return this; }
  send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}
const PROBE = `(() => {
  const roots = document.querySelectorAll('div[style*="2147483647"]').length;
  const chipBtns = Array.from(document.querySelectorAll('button'))
    .filter(b => (b.textContent || '').includes('→ add to session')).length;
  return JSON.stringify({ chipStripRoots: roots, addSessionButtons: chipBtns,
    overlay: !!document.querySelector('[data-chrome-eye-overlay]'),
    title: document.title, url: location.href });
})()`;
function makeSession(cdp) {
  const consoleEvents = []; const contexts = [];
  cdp.on('Runtime.consoleAPICalled', (p) => {
    consoleEvents.push((p.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
  });
  cdp.on('Runtime.executionContextCreated', (p) => contexts.push(p.context));
  return {
    consoleEvents, contexts,
    start: async () => { await cdp.send('Runtime.enable'); await cdp.send('Page.enable'); },
    frameTree: async () => (await cdp.send('Page.getFrameTree')).frameTree,
    evalIn: async (cid, expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, contextId: cid, returnByValue: true, awaitPromise: true });
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

async function main() {
  const ts = await listTargets();
  const sw = ts.find((t) => t.type === 'service_worker');
  if (!sw) throw new Error('no live SW target; run right after launch');
  const extId = new URL(sw.url).host;
  fs.writeFileSync('/mnt/f/ai/chrome-eye/scratch/ext-id.txt', extId + '\n');
  console.log('LIVE_EXT_ID=' + extId);

  const panelUrl = `chrome-extension://${extId}/panel.html`;
  let panelT = ts.find((t) => t.type === 'page' && t.url.startsWith('chrome-extension://'));
  const nav = await Cdp.connect(panelT.webSocketDebuggerUrl);
  await nav.send('Page.enable');
  await nav.send('Page.navigate', { url: panelUrl });
  await sleep(3000);
  const after = (await listTargets()).find((t) => t.id === panelT.id);
  console.log('panel tab ' + panelT.id + ' now: ' + after.url);
  nav.close();

  let guiT = (await listTargets()).find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:3080'));
  if (!guiT) { guiT = await newTab('http://127.0.0.1:3080'); console.log('opened gui tab ' + guiT.id); }
  else console.log('reusing gui tab ' + guiT.id);

  const panelCdp = await Cdp.connect(panelT.webSocketDebuggerUrl);
  const guiCdp = await Cdp.connect(guiT.webSocketDebuggerUrl);
  const panelS = makeSession(panelCdp); const guiS = makeSession(guiCdp);
  await panelS.start(); await guiS.start();
  await sleep(8000); // >= 2 chip poll cycles (2 s) after panel-open message

  console.log('\n--- CONSOLE (panel tab) ---');
  for (const l of panelS.consoleEvents.slice(0, 40)) console.log('  ' + l);
  console.log('--- CONSOLE (gui tab) ---');
  for (const l of guiS.consoleEvents.slice(0, 40)) console.log('  ' + l);

  const ft = await panelS.frameTree();
  console.log('\n--- PANEL PAGE FRAME TREE ---');
  const dump = (n, d = 0) => { console.log('  '.repeat(d) + `[${n.frame.id}] ${n.frame.url}`); for (const c of n.childFrames ?? []) dump(c, d + 1); };
  dump(ft);

  const iframes = findFrames(ft, (f) => (f.url || '').startsWith('http://127.0.0.1:3080'));
  console.log('\n:3080 frames inside panel page: ' + iframes.length);
  const guiMain = findFrames(await guiS.frameTree(), () => true)[0];
  console.log('gui tab top frame: ' + guiMain.url);

  const guiCtx = guiS.contexts.find((c) => c.auxData?.frameId === guiMain.id);
  console.log('\n--- PROBE real GUI tab main context (positive control) ---');
  console.log(guiCtx ? await guiS.evalIn(guiCtx.id, PROBE) : 'no main context');

  for (const f of iframes) {
    const c = panelS.contexts.find((x) => x.auxData?.frameId === f.id);
    console.log(`\n--- PROBE panel iframe ${f.id} (origin ${c?.origin ?? '?'}) ---`);
    console.log(c ? await panelS.evalIn(c.id, PROBE) : 'NO execution context for iframe');
  }
  const topCtx = panelS.contexts.find((c) => (c.origin || '').includes('chrome-extension'));
  if (topCtx) {
    console.log('\n--- PROBE panel top frame ---');
    console.log(await panelS.evalIn(topCtx.id, PROBE));
  }
  panelCdp.close(); guiCdp.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
