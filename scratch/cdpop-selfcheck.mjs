// CDP-OP self-check: wake SW via existing panel page, probe new code, screenshot panel top-level.
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

// --- 1) Wake the SW using the EXISTING panel page (no new tabs) ---
let targets = await J('http://127.0.0.1:9222/json');
const panel = targets.find((t) => t.type === 'page' && t.url.includes('panel.html'));
if (!panel) throw new Error('no panel target');

const ver = await J('http://127.0.0.1:9222/json/version');
const br = makeRpc(await connect(ver.webSocketDebuggerUrl));
const panelRpc = makeRpc(await connect(panel.webSocketDebuggerUrl));

let swSession = null;
for (let i = 0; i < 60 && !swSession; i++) {
  const tg = await br.call('Target.getTargets');
  const swT = tg.targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(EXT));
  if (swT) {
    try {
      const att = await br.call('Target.attachToTarget', { targetId: swT.targetId, flatten: true });
      swSession = att.sessionId;
    } catch (e) { /* attach race; retry */ }
  } else {
    try {
      await panelRpc.call('Runtime.evaluate', {
        expression: "chrome.runtime.sendMessage({type:'chrome-eye:panel-state'}).then(()=>1).catch(()=>0)",
        awaitPromise: true,
      }, undefined, 8000);
    } catch (e) { /* panel not ready yet; keep nudging */ }
  }
  if (!swSession) await sleep(500);
}
if (!swSession) throw new Error('SW did not appear within 30s');

// 2) SW new-code probe
const swRes = await br.call('Runtime.evaluate', {
  expression: "JSON.stringify({staged: stagedTabs.length, fn: typeof hookUrlMatch === 'function'})",
  returnByValue: true,
}, swSession);
console.log('SW_PROBE=' + (swRes.result && swRes.result.value));

// --- 3) Panel screenshot (top-level; compositor includes the :3081 OOPIF) ---
await panelRpc.call('Page.enable');
const frameInfo = await panelRpc.call('Runtime.evaluate', {
  expression: "(() => { const f = document.querySelector('iframe'); return JSON.stringify({ready: document.readyState, src: f ? f.src : null}); })()",
  returnByValue: true,
});
console.log('PANEL_FRAME=' + frameInfo.result.value);

let iframeReady = false;
for (let i = 0; i < 20 && !iframeReady; i++) {
  const tg = await br.call('Target.getTargets');
  const iframeT = tg.targetInfos.find((t) => t.type === 'iframe' && t.url.includes('127.0.0.1:3081'));
  if (iframeT) {
    try {
      const att = await br.call('Target.attachToTarget', { targetId: iframeT.targetId, flatten: true });
      const st = await br.call('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, att.sessionId);
      if (st.result.value === 'complete') iframeReady = true;
    } catch (e) { /* retry */ }
  }
  if (!iframeReady) await sleep(1500);
}
console.log('IFRAME_READY=' + iframeReady);

const shot = await panelRpc.call('Page.captureScreenshot', { format: 'png' }, 20000);
writeFileSync('/mnt/f/ai/chrome-eye/scratch/cdpop-selfcheck.png', Buffer.from(shot.data, 'base64'));
console.log('PNG_BYTES=' + Buffer.from(shot.data, 'base64').length);
panelRpc.close();
br.close();
console.log('DONE');
