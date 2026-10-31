#!/usr/bin/env node
// PROBE: is the Chrome side panel a chrome.tabs entry (and does
// webNavigation.getAllFrames see its child frames) in headless Chrome 152?
// Self-contained: launches a fresh-profile Chrome on :9222, kills it at the end.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const BASE = 'http://127.0.0.1:9222';
const CHROME = '/mnt/f/ai/chrome-eye/test/chrome/chrome-linux64/chrome';
const LIBS = '/mnt/f/ai/chrome-eye/test/chrome-libs/usr/lib/x86_64-linux-gnu';
const EXT = '/mnt/f/ai/chrome-eye/extension';
const UDATA = '/mnt/f/ai/chrome-eye/scratch/udata-panel-probe';
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

async function listTargets() {
  try {
    const r = await fetch(`${BASE}/json/list`, { signal: AbortSignal.timeout(2000) });
    return await r.json();
  } catch { return []; }
}

async function swEval(cdp, expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: 10000 });
  if (r.exceptionDetails) throw new Error('eval exception: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}

let chromeProc = null;
async function main() {
  fs.rmSync(UDATA, { recursive: true, force: true });
  chromeProc = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check',
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--remote-debugging-port=9222', '--window-size=1280,900',
    `--user-data-dir=${UDATA}`, 'about:blank'
  ], { env: { ...process.env, LD_LIBRARY_PATH: LIBS }, stdio: ['ignore', 'pipe', 'pipe'] });
  chromeProc.stdout.on('data', () => {}); chromeProc.stderr.on('data', (d) => process.stderr.write('[chrome] ' + d));
  chromeProc.on('exit', (code) => console.log('chrome exited', code));

  // wait for SW target
  let sw = null, extId = null;
  for (let i = 0; i < 60 && !sw; i++) {
    await sleep(500);
    const ts = await listTargets().catch(() => []);
    sw = ts.find((t) => t.type === 'service_worker');
    if (sw) extId = new URL(sw.url).host;
  }
  if (!sw) throw new Error('no service_worker target');
  console.log('EXT_ID', extId);

  const cdp = await Cdp.connect(sw.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  console.log('\n--- BEFORE opening side panel ---');
  console.log('tabs:', await swEval(cdp, `chrome.tabs.query({}).then(ts => JSON.stringify(ts.map(t => ({id:t.id,url:t.url,active:t.active}))))`));
  const wins = await swEval(cdp, `chrome.windows.getAll({populate:false}).then(w => JSON.stringify(w.map(x => ({id:x.id,focused:x.focused,type:x.type}))))`);
  console.log('windows:', wins);
  const winId = JSON.parse(wins)[0].id;

  console.log('\n--- chrome.sidePanel.open({windowId:' + winId + '}) ---');
  const openRes = await swEval(cdp, `chrome.sidePanel.open({windowId:${winId}}).then(() => 'OPENED').catch(e => 'ERR:' + String(e && e.message || e))`);
  console.log('open result:', openRes);
  await sleep(4000);

  console.log('\n--- AFTER opening side panel: CDP targets ---');
  for (const t of await listTargets()) console.log(`  [${t.type}] ${t.id} ${t.url}`);

  console.log('\n--- AFTER: chrome.tabs.query({}) from SW ---');
  const tabsAfter = await swEval(cdp, `chrome.tabs.query({}).then(ts => JSON.stringify(ts.map(t => ({id:t.id,url:t.url}))))`);
  console.log(tabsAfter);

  const panelTab = JSON.parse(tabsAfter).find((t) => t.url && t.url.indexOf('panel.html') !== -1);
  if (panelTab) {
    console.log('\n--- webNavigation.getAllFrames(panel tab ' + panelTab.id + ') ---');
    console.log(await swEval(cdp, `chrome.webNavigation.getAllFrames({tabId:${panelTab.id}}).then(fs => JSON.stringify(fs.map(f => ({frameId:f.frameId,parentFrameId:f.parentFrameId,url:f.url})))).catch(e => 'ERR:' + e.message)`));
  } else {
    console.log('\nNO panel.html tab in chrome.tabs — side panel is NOT a tab (or did not open).');
  }

  cdp.close();
}

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
process.on('exit', () => { try { if (chromeProc) chromeProc.kill('SIGKILL'); } catch {} });
