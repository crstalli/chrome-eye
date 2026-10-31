#!/usr/bin/env node
// Probe the scratch topology page: top frame (http) + child :3080 frame.
// Verifies all_frames:false behavior — content script in top frame only.
const BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listTargets = async () => (await fetch(`${BASE}/json/list`)).json();
const newTab = async (url) => {
  const r = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!r.ok) throw new Error('json/new ' + r.status);
  return r.json();
};
const closeTarget = async (id) => { await fetch(`${BASE}/json/close/${id}`); };
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
async function main() {
  const t = await newTab('http://127.0.0.1:8899/frame-test.html');
  console.log('opened ' + t.id);
  const cdp = await Cdp.connect(t.webSocketDebuggerUrl);
  const consoles = []; const contexts = [];
  cdp.on('Runtime.consoleAPICalled', (p) => consoles.push((p.args || []).map((a) => a.value ?? a.description ?? '').join(' ')));
  cdp.on('Runtime.executionContextCreated', (p) => contexts.push(p.context));
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  await sleep(8000);
  const ft = (await cdp.send('Page.getFrameTree')).frameTree;
  const dump = (n, d = 0) => { console.log('  '.repeat(d) + `[${n.frame.id}] ${n.frame.url}`); for (const c of n.childFrames ?? []) dump(c, d + 1); };
  console.log('FRAME TREE:'); dump(ft);
  console.log('\nCONSOLE:'); for (const l of consoles.slice(0, 30)) console.log('  ' + l);
  function findFrames(node, pred, out = []) {
    if (pred(node.frame)) out.push(node.frame);
    for (const c of node.childFrames ?? []) findFrames(c, pred, out);
    return out;
  }
  const all = findFrames(ft, () => true);
  for (const f of all) {
    const c = contexts.find((x) => x.auxData?.frameId === f.id);
    console.log(`\n--- context ${c?.origin ?? 'NONE'} frame ${f.id} ---`);
    console.log(c ? await cdp.send('Runtime.evaluate', { expression: PROBE, contextId: c.id, returnByValue: true }).then((r) => r.result.value) : 'no execution context');
  }
  cdp.close();
  await closeTarget(t.id);
  console.log('\nclosed test tab');
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
