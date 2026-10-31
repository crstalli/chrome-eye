// CDP-OP self-check (take 2): fresh panel page -> wait for :3081 iframe ready -> top-level screenshot -> close my tab.
import { writeFileSync } from 'node:fs';

const J = (url) => fetch(url, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXT = 'mlolgaoijponghgfnlcljlohnhlpnhkd';

function connect(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => rej(new Error('ws connect timeout')), 10000);
    ws.onopen = () => { clearTimeout(t); res(ws); };
    ws.onerror = () => { clearTimeout(t); rej(new Error('ws error')); };
  });
}

function makeRpc(ws) {
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString());
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  return {
    call(method, params = {}, sessionId, timeoutMs = 15000) {
      return new Promise((res, rej) => {
        const mid = ++id;
        const t = setTimeout(() => { pending.delete(mid); rej(new Error(`timeout: ${method}`)); }, timeoutMs);
        const p = { id: mid, method, params };
        if (sessionId) p.sessionId = sessionId;
        pending.set(mid, (msg) => { clearTimeout(t); msg.error ? rej(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : res(msg.result); });
        ws.send(JSON.stringify(p));
      });
    },
    close: () => ws.close(),
  };
}

const ver = await J('http://127.0.0.1:9222/json/version');
const br = makeRpc(await connect(ver.webSocketDebuggerUrl));

// 1) Create a fresh panel page (mine to close later)
const created = await br.call('Target.createTarget', { url: `chrome-extension://${EXT}/panel.html` });
const myPanelId = created.targetId;
console.log('MY_PANEL=' + myPanelId);

// 2) Wait for the page + its :3081 OOPIF to be ready
let panelWsUrl = null;
let iframeReady = false;
for (let i = 0; i < 40 && !iframeReady; i++) {
  const tg = await br.call('Target.getTargets');
  const pT = tg.targetInfos.find((t) => t.targetId === myPanelId);
  const iframeT = tg.targetInfos.find((t) => t.type === 'iframe' && t.url.includes('127.0.0.1:3081'));
  if (iframeT) {
    try {
      const att = await br.call('Target.attachToTarget', { targetId: iframeT.targetId, flatten: true });
      const st = await br.call('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, att.sessionId);
      if (st.result.value === 'complete') iframeReady = true;
    } catch (e) { /* retry */ }
  }
  if (iframeReady && !panelWsUrl) panelWsUrl = (await J('http://127.0.0.1:9222/json')).find((t) => t.id === myPanelId)?.webSocketDebuggerUrl;
  if (!iframeReady || !panelWsUrl) await sleep(1000);
}
if (!iframeReady || !panelWsUrl) throw new Error('panel/iframe not ready: iframeReady=' + iframeReady + ' ws=' + panelWsUrl);

// 3) Top-level screenshot of the panel (compositor includes the OOPIF GUI)
const panelRpc = makeRpc(await connect(panelWsUrl));
await panelRpc.call('Page.enable');
const shot = await panelRpc.call('Page.captureScreenshot', { format: 'png' }, undefined, 20000);
const buf = Buffer.from(shot.data, 'base64');
writeFileSync('/mnt/f/ai/chrome-eye/scratch/cdpop-selfcheck.png', buf);
console.log('PNG_BYTES=' + buf.length);
panelRpc.close();

// 4) Cleanup: close my panel page
const closed = await br.call('Target.closeTarget', { targetId: myPanelId });
console.log('CLOSED_MY_PANEL=' + closed.success);
br.close();
console.log('DONE');
