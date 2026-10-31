#!/usr/bin/env node
// PROBE v4: evidence pass on the REAL side panel (opened in probe v3, no cookie):
//  - windows.getAll({populate:true}) structure
//  - real panel target identity + its 401 iframe committed content
//  - click Workspaces in the REAL side panel → exact dropdown text (SW fallback
//    should NOT engage: real panel is not a tab → original error)
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
const jt = async (p) => (await fetch(`${BASE}${p}`, { signal: AbortSignal.timeout(4000) })).json();
const ev = (cdp, expression) => cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 10000 }).then((r) => {
  if (r.exceptionDetails) return 'EVAL-ERR: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
});

async function main() {
  const targets = await jt('/json/list');
  const panelPages = targets.filter((t) => t.type === 'page' && t.url && t.url.indexOf('panel.html') !== -1);
  console.log('panel.html page targets:', panelPages.map((t) => t.id).join(', '));
  const realPanel = panelPages[0]; // the one created by sidePanel.open (not 2AB5... the tab)
  const tabId = '2AB538F0F61CE99FD90FBD1EC97EF675';
  const panelTarget = panelPages.find((t) => t.id !== tabId) || panelPages[0];
  console.log('real panel target:', panelTarget.id);

  // 1. windows structure from SW (wake it first: runtime message from panel tab)
  const tabTarget = panelPages.find((t) => t.id === tabId) || panelPages[0];
  const waker = await Cdp.connect(tabTarget.webSocketDebuggerUrl);
  await waker.send('Runtime.enable');
  await ev(waker, 'chrome.runtime.sendMessage({type:"__probe-wake__"}).catch(() => null)').catch(() => {});
  waker.close();
  let sw = null;
  for (let i = 0; i < 20 && !sw; i++) {
    await sleep(500);
    sw = (await jt('/json/list')).find((t) => t.type === 'service_worker');
  }
  if (!sw) throw new Error('no SW target after wake');
  const swc = await Cdp.connect(sw.webSocketDebuggerUrl);
  await swc.send('Runtime.enable');
  console.log('\nwindows (populate):', await ev(swc, 'chrome.windows.getAll({populate:true}).then(w => JSON.stringify(w.map(x => ({id:x.id,tabs:(x.tabs||[]).map(t=>({id:t.id,url:t.url})),focused:x.focused}))))'));
  swc.close();

  // 2. real panel identity
  const rp = await Cdp.connect(panelTarget.webSocketDebuggerUrl);
  await rp.send('Runtime.enable');
  console.log('\nreal panel doc:', await ev(rp, 'JSON.stringify({href: location.href, title: document.title, hasWsBtn: !!document.getElementById("ws-tree-btn"), hasIframe: !!document.getElementById("dsh-iframe")})'));
  rp.close();

  // 3. real panel's iframe (401, no cookie) committed content
  const iframe = (await jt('/json/list')).find((t) => t.type === 'iframe' && t.url === 'http://127.0.0.1:3080/');
  console.log('\npanel iframe targets:', (await jt('/json/list')).filter((t) => t.type === 'iframe').map((t) => t.id + ' ' + t.url).join(' | '));
  if (iframe) {
    const ifr = await Cdp.connect(iframe.webSocketDebuggerUrl);
    await ifr.send('Runtime.enable');
    console.log('iframe doc:', await ev(ifr, 'JSON.stringify({href: location.href, bodyText: (document.body ? document.body.innerText : "").slice(0, 300)})'));
    ifr.close();
  }

  // 4. click Workspaces in the REAL side panel (no cookie) → exact dropdown text
  const rp2 = await Cdp.connect(panelTarget.webSocketDebuggerUrl);
  await rp2.send('Runtime.enable');
  await ev(rp2, 'document.getElementById("ws-tree-btn").click(); "clicked"');
  await sleep(2500);
  console.log('\nREAL panel (no cookie) dropdown after click:', await ev(rp2, 'JSON.stringify({ddHidden: document.getElementById("ws-dropdown").hasAttribute("hidden"), ddBody: document.getElementById("ws-dropdown-body") ? document.getElementById("ws-dropdown-body").textContent : (document.getElementById("ws-dropdown").textContent || "").slice(0, 400)})'));
  rp2.close();
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
