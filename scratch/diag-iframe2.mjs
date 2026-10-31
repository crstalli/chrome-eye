#!/usr/bin/env node
// Trace frame lifecycle for the panel's :3080 iframe.
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
  const ev = [];
  for (const m of ['Page.frameStartedLoading', 'Page.frameStoppedLoading', 'Page.frameNavigated', 'Page.frameDetached', 'Page.frameRequestedNavigation', 'Page.navigatedWithinDocument']) {
    cdp.on(m, (p) => ev.push(`${m}: frame=${p.frame?.id} url=${p.frame?.url ?? p.frameId ?? ''} err=${p.errorText ?? ''}`));
  }
  cdp.on('Runtime.consoleAPICalled', (p) => ev.push('console.' + p.type + ': ' + (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200)));
  cdp.on('Network.loadingFailed', (p) => ev.push('net-fail: ' + p.errorText + (p.blockedByClient ? ' blockedByClient' : '')));
  cdp.on('Network.responseReceived', (p) => { if (!p.response.url.includes('panel.html') && !p.response.url.includes('.js') && !p.response.url.includes('.css')) ev.push('net-resp: ' + p.response.status + ' ' + p.response.url); });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');

  await cdp.send('Page.reload');
  await sleep(6000);

  console.log('EVENTS:');
  for (const e of ev.slice(0, 80)) console.log('  ' + e);
  const ft = (await cdp.send('Page.getFrameTree')).frameTree;
  const dump = (n, d = 0) => { console.log('  '.repeat(d) + `[${n.frame.id}] ${n.frame.url}`); for (const c of n.childFrames ?? []) dump(c, d + 1); };
  console.log('\nFRAME TREE:');
  dump(ft);
  cdp.close();
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
