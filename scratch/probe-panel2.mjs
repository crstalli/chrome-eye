#!/usr/bin/env node
// PROBE v2 (attaches to already-running Chrome on :9222):
// Is the side panel a chrome.tabs entry? Does webNavigation see its frames?
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const cdp = new Cdp(ws);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
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
  on(method, fn) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(fn); return this; }
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

const jt = async (p, method = 'GET') => (await fetch(`${BASE}${p}`, { method, signal: AbortSignal.timeout(4000) })).json();

async function main() {
  let targets = await jt('/json/list');
  let sw = targets.find((t) => t.type === 'service_worker');
  let extId = null;

  if (!sw) {
    // wake the SW: load the extension's panel.html in the existing about:blank tab.
    // candidate ext id from ext-id.txt (unpacked-ext id is a stable path hash)
    const cand = fs.readFileSync('/mnt/f/ai/chrome-eye/scratch/ext-id.txt', 'utf8').trim();
    const blank = targets.find((t) => t.type === 'page' && t.url === 'about:blank');
    console.log('candidate ext id:', cand);
    const nav = await Cdp.connect(blank.webSocketDebuggerUrl);
    await nav.send('Page.enable');
    await nav.send('Page.navigate', { url: `chrome-extension://${cand}/panel.html` });
    await sleep(3000);
    const r = await nav.send('Runtime.evaluate', { expression: 'JSON.stringify({href: location.href, title: document.title, extId: (typeof chrome !== "undefined" && chrome.runtime) ? chrome.runtime.id : null})', returnByValue: true });
    console.log('panel tab state:', r.result.value);
    const parsed = JSON.parse(r.result.value);
    extId = parsed.extId || cand;
    nav.close();
    for (let i = 0; i < 20 && !sw; i++) {
      await sleep(500);
      targets = await jt('/json/list');
      sw = targets.find((t) => t.type === 'service_worker');
    }
  }
  if (!sw) { console.log('RESULT: no service_worker target ever appeared'); process.exit(0); }
  if (!extId) extId = new URL(sw.url).host;
  console.log('EXT_ID', extId, 'SW target:', sw.id);

  const cdp = await Cdp.connect(sw.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  const swEval = (expr) => cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 10000 }).then((r) => {
    if (r.exceptionDetails) return 'EVAL-ERR: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  });

  console.log('\n--- tabs BEFORE sidePanel.open ---');
  console.log(await swEval(`chrome.tabs.query({}).then(ts => JSON.stringify(ts.map(t => ({id:t.id,url:t.url}))))`));
  console.log('windows:', await swEval(`chrome.windows.getAll({}).then(w => JSON.stringify(w.map(x => ({id:x.id,focused:x.focused,type:x.type}))))`));
  const winId = JSON.parse(await swEval(`chrome.windows.getAll({}).then(w => w[0].id)`));

  console.log('\n--- sidePanel.open({windowId:' + winId + '}) ---');
  console.log(await swEval(`chrome.sidePanel.open({windowId:${winId}}).then(() => 'OPENED').catch(e => 'ERR:' + String(e && e.message || e))`));
  await sleep(5000);

  console.log('\n--- CDP targets AFTER ---');
  for (const t of await jt('/json/list')) console.log(`  [${t.type}] ${t.id} ${t.url}`);

  console.log('\n--- tabs AFTER sidePanel.open ---');
  const tabsAfter = await swEval(`chrome.tabs.query({}).then(ts => JSON.stringify(ts.map(t => ({id:t.id,url:t.url}))))`);
  console.log(tabsAfter);

  const panelTab = JSON.parse(tabsAfter).find((t) => t.url && t.url.indexOf('panel.html') !== -1);
  if (panelTab) {
    console.log('\n--- getAllFrames(panel tab ' + panelTab.id + ') ---');
    console.log(await swEval(`chrome.webNavigation.getAllFrames({tabId:${panelTab.id}}).then(fs => JSON.stringify(fs.map(f => ({frameId:f.frameId,parentFrameId:f.parentFrameId,url:f.url})))).catch(e => 'ERR:' + e.message)`));
  } else {
    console.log('\nRESULT: NO panel.html entry in chrome.tabs after sidePanel.open — side panel is NOT a tab.');
  }
  cdp.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
