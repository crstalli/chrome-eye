#!/usr/bin/env node
// PROBE v3: can the REAL side panel be opened in headless Chrome 152 (via
// transient activation from a CDP trusted click), and if so, is it a
// chrome.tabs entry? Attaches to the running Chrome on :9222.
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
  const targets = await jt('/json/list');
  const panelPage = targets.find((t) => t.type === 'page' && t.url && t.url.indexOf('panel.html') !== -1);
  if (!panelPage) throw new Error('no panel.html page target');
  console.log('panel page target:', panelPage.id, panelPage.url);

  const page = await Cdp.connect(panelPage.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  const ev = (expression) => page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 10000 }).then((r) => {
    if (r.exceptionDetails) return 'EVAL-ERR: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  });

  // 1. trusted click on the panel page → transient activation
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 });
  console.log('hasTransientActivation:', await ev('document.hasTransientActivation()'));

  // 2. windows from the page context
  const wins = await ev('chrome.windows.getAll({}).then(w => JSON.stringify(w.map(x => ({id:x.id,focused:x.focused}))))');
  console.log('windows:', wins);
  const winId = JSON.parse(wins)[0].id;

  // 3. try opening the REAL side panel from the page context (with activation)
  console.log('sidePanel.open:', await ev(`chrome.sidePanel.open({windowId:${winId}}).then(() => 'OPENED').catch(e => 'ERR:' + String(e && e.message || e))`));
  await sleep(4000);

  // 4. what appeared? CDP targets + SW tabs.query
  console.log('\n--- CDP targets after ---');
  for (const t of await jt('/json/list')) console.log(`  [${t.type}] ${t.id} ${t.url}`);

  // wake SW if needed and query tabs
  await ev('chrome.runtime.sendMessage({type:"__probe-wake__"}).catch(() => null)').catch(() => {});
  let sw = null;
  for (let i = 0; i < 20 && !sw; i++) {
    await sleep(500);
    sw = (await jt('/json/list')).find((t) => t.type === 'service_worker');
  }
  if (sw) {
    const swc = await Cdp.connect(sw.webSocketDebuggerUrl);
    await swc.send('Runtime.enable');
    const tabs = await swc.send('Runtime.evaluate', {
      expression: 'chrome.tabs.query({}).then(ts => JSON.stringify(ts.map(t => ({id:t.id,url:t.url}))))',
      returnByValue: true, awaitPromise: true
    }).then((r) => r.result.value);
    console.log('\n--- chrome.tabs.query({}) after ---');
    console.log(tabs);
    swc.close();
  } else {
    console.log('\n(no SW target)');
  }
  page.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
