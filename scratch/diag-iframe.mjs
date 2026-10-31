#!/usr/bin/env node
// Diagnose why the panel's :3080 iframe is absent from the frame tree.
const BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listTargets = async () => (await fetch(`${BASE}/json/list`)).json();
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
async function main() {
  const ts = await listTargets();
  const panelT = ts.find((t) => t.type === 'page' && t.url.includes('/panel.html'));
  if (!panelT) throw new Error('panel tab not found');
  const cdp = await Cdp.connect(panelT.webSocketDebuggerUrl);
  const events = [];
  cdp.on('Runtime.consoleAPICalled', (p) => events.push('console.' + p.type + ': ' + (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ')));
  cdp.on('Log.entryAdded', (p) => events.push('log[' + p.entry.level + ']: ' + p.entry.text + ' ' + (p.entry.url || '')));
  cdp.on('Network.loadingFailed', (p) => events.push('net-fail: req' + p.requestId + ' ' + p.errorText + (p.blockedByClient ? ' (blockedByClient)' : '')));
  cdp.on('Network.responseReceived', (p) => {
    if (p.response.url.startsWith('http://127.0.0.1:3080')) events.push('net-resp: ' + p.response.status + ' ' + p.response.url);
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');
  await cdp.send('Log.enable');

  // element state before reload
  const before = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify({
    iframe: !!document.getElementById('dsh-iframe'),
    src: document.getElementById('dsh-iframe') ? document.getElementById('dsh-iframe').src : null,
    complete: document.readyState,
    buttons: ['share-status','ws-overlay-btn','ws-tree-btn','ws-dropdown'].map(id => !!document.getElementById(id))
  })`, returnByValue: true });
  console.log('BEFORE:', before.result.value);

  await cdp.send('Page.reload');
  await sleep(8000);

  const ft = (await cdp.send('Page.getFrameTree')).frameTree;
  const dump = (n, d = 0) => { console.log('  '.repeat(d) + `[${n.frame.id}] ${n.frame.url}`); for (const c of n.childFrames ?? []) dump(c, d + 1); };
  console.log('\nFRAME TREE AFTER RELOAD:');
  dump(ft);

  const after = await cdp.send('Runtime.evaluate', { expression: `JSON.stringify({
    src: document.getElementById('dsh-iframe') ? document.getElementById('dsh-iframe').src : null,
    complete: document.readyState
  })`, returnByValue: true });
  console.log('\nAFTER:', after.result.value);
  console.log('\nEVENTS:');
  for (const e of events.slice(0, 60)) console.log('  ' + e);
  cdp.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
